const mongoose = require("mongoose");

const DailyCustomerReport = require("../models/DailyCustomerReport");
const Customer = require("../models/Customer");
const User = require("../models/User");
const DailyReportFinanceEntry = require("../models/DailyReportFinanceEntry");
const {
  buildCustomerLookupMap,
  buildCustomerSelectFields,
  normalizeCustomerKey,
  normalizeClientType,
  upsertCustomerByName,
  upsertCustomerByPreviousName,
  toTitleCase,
} = require("../utils/customerMaster");
const { getRange } = require("../utils/period");

function isValidDateKey(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function normalizeDateField(value) {
  const s = String(value || "").trim();
  return isValidDateKey(s) ? s : "";
}

function readCollectionAmount(row = {}) {
  return Number(row?.poReceived ?? row?.salespersonPoReceived ?? row?.collection ?? row?.collected ?? 0);
}

function readSalesAmount(row = {}) {
  return Number(row?.salespersonSalesInvoiced ?? row?.orderGenerated ?? 0);
}

const ENQUIRY_MODE_OPTIONS = new Set([
  "Direct",
  "Supplier",
  "Existing Customer",
  "Online",
  "Other",
]);

function normalizeEnquiryMode(value) {
  const text = toTitleCase(value);
  if (!text) return "";
  if (ENQUIRY_MODE_OPTIONS.has(text)) return text;
  const lowered = text.toLowerCase();
  if (lowered.includes("direct")) return "Direct";
  if (lowered.includes("supplier")) return "Supplier";
  if (lowered.includes("existing")) return "Existing Customer";
  if (lowered.includes("online")) return "Online";
  if (lowered.includes("other")) return "Other";
  return "Other";
}

async function buildSalespersonSnapshot(userId) {
  if (!userId) return { salespersonName: "", salespersonEmail: "" };
  const user = await User.findById(userId).select("name email").lean();
  return {
    salespersonName: String(user?.name || "").trim(),
    salespersonEmail: String(user?.email || "").trim(),
  };
}

async function getFinanceEntriesForReport(reportDoc) {
  if (!reportDoc?._id) return [];
  return DailyReportFinanceEntry.find({ dailyReportId: reportDoc._id })
    .sort({ entryDate: 1, createdAt: 1 })
    .lean();
}

function indexFinanceEntriesByReport(entries) {
  const map = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const reportId = String(entry?.dailyReportId || "").trim();
    if (!reportId) continue;
    const list = map.get(reportId) || [];
    list.push(entry);
    map.set(reportId, list);
  }
  return map;
}

function applyFinanceTotalsToRows(rows, entries) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeEntries = Array.isArray(entries) ? entries : [];

  return safeRows.map((row) => {
    const rowId = String(row?._id || "");
    const rowEntries = safeEntries.filter((entry) => String(entry?.rowId || "") === rowId);
    const invoiceEntries = rowEntries.filter((entry) => entry.type === "INVOICE");
    const collectionEntries = rowEntries.filter((entry) => entry.type === "COLLECTION");
    const adminSalesInvoiced = invoiceEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    const salespersonSalesInvoiced = readSalesAmount(row);
    const salespersonPoReceived = Number(
      row?.salespersonPoReceived ?? row?.poReceived ?? row?.collection ?? row?.collected ?? 0
    );
    const adminCollection = collectionEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);

    return {
      ...row,
      orderGenerated: salespersonSalesInvoiced || Number(row?.orderGenerated || 0),
      salespersonPoReceived,
      salespersonSalesInvoiced,
      salesInvoiced: adminSalesInvoiced,
      sales: adminSalesInvoiced,
      salesInvoiceDate: invoiceEntries.length ? String(invoiceEntries[invoiceEntries.length - 1].entryDate || "") : "",
      poReceived: salespersonPoReceived + adminCollection,
      collectionDate: collectionEntries.length
        ? String(collectionEntries[collectionEntries.length - 1].entryDate || "")
        : "",
    };
  });
}

async function rebuildFinanceTotalsForReport(reportDoc) {
  if (!reportDoc) return null;

  const entries = await getFinanceEntriesForReport(reportDoc);
  const nextRows = applyFinanceTotalsToRows(reportDoc.rows, entries);

  reportDoc.rows = nextRows;
  await reportDoc.save();
  return { report: reportDoc, entries };
}

function findDuplicateCustomerRow(rows) {
  const seen = new Map();

  for (let index = 0; index < (Array.isArray(rows) ? rows.length : 0); index++) {
    const row = rows[index] || {};
    const key = normalizeCustomerKey(row.customerName);
    if (!key) continue;

    if (seen.has(key)) {
      const firstIndex = seen.get(key);
      return {
        customerName: String(row.customerName || "").trim(),
        firstIndex,
        duplicateIndex: index,
      };
    }

    seen.set(key, index);
  }

  return null;
}

function buildDuplicateCustomerMessage(duplicate) {
  if (!duplicate) return "";
  const name = duplicate.customerName || "client";
  return `Duplicate client "${name}" found in rows ${duplicate.firstIndex + 1} and ${duplicate.duplicateIndex + 1}. Each client can appear only once per report.`;
}

async function buildCustomerLookup() {
  const customers = await Customer.find({}).select(buildCustomerSelectFields()).lean();
  return buildCustomerLookupMap(customers);
}

function enrichCustomerRow(row, customerLookup) {
  const rowId = String(row?._id || row?.rowId || "").trim();
  const name = toTitleCase(row?.customerName);
  const customerId = String(row?.customerId || "").trim();
  const found =
    (customerId ? customerLookup.get(`id:${customerId}`) : null) ||
    customerLookup.get(normalizeCustomerKey(name));
  const orderGenerated = Number(
    row?.orderGenerated ?? row?.order ?? row?.orderValue ?? row?.orderAmount ?? 0
  );
  const salesInvoiced = Number(
    row?.salesInvoiced ?? row?.sales ?? row?.salesAmount ?? row?.invoiceAmount ?? 0
  );
  const salespersonSalesInvoiced = readSalesAmount(row);
  const poReceived = readCollectionAmount(row);
  const salespersonPoReceived = Number(
    row?.salespersonPoReceived ?? row?.poReceived ?? row?.collection ?? row?.collected ?? 0
  );

  return {
    _id: rowId,
    rowId,
    customerId: customerId || found?.customerId || "",
    customerName: name,
    newOrExisting: row?.newOrExisting === "New" ? "New" : "Existing",
    clientType: normalizeClientType(row?.clientType || row?.type || row?.newOrExisting, found?.clientType || "Existing"),
    area: toTitleCase(row?.area || found?.area),
    metTo: toTitleCase(row?.metTo || found?.metTo),
    designation: toTitleCase(row?.designation || found?.designation),
    enquiryMode: normalizeEnquiryMode(row?.enquiryMode),
    orderGenerated: salespersonSalesInvoiced || orderGenerated,
    salesInvoiced,
    sales: salesInvoiced,
    segment: toTitleCase(row?.segment || found?.segment),
    salespersonSalesInvoiced,
    salespersonPoReceived,
    poReceived,
    salesInvoiceDate: normalizeDateField(row?.salesInvoiceDate || row?.invoiceDate || row?.salesInvoicedDate),
    collectionDate: normalizeDateField(row?.collectionDate || row?.poReceivedDate || row?.receivedDate),
  };
}

async function buildLatestCustomerVisitTemplate(userId, customerName) {
  const name = toTitleCase(customerName);
  if (!name) return null;

  const reports = await DailyCustomerReport.find({ userId })
    .select("reportDateKey rows")
    .sort({ reportDateKey: -1, updatedAt: -1 })
    .lean();

  let matchedRow = null;
  for (const report of reports) {
    const rows = Array.isArray(report?.rows) ? report.rows : [];
    matchedRow = rows.find((r) => normalizeCustomerKey(r?.customerName) === normalizeCustomerKey(name));
    if (matchedRow) break;
  }

  const customerLookup = await buildCustomerLookup();
  const master = customerLookup.get(normalizeCustomerKey(name)) || {};
  const base = matchedRow
    ? enrichCustomerRow(matchedRow, customerLookup)
    : {
        customerName: name,
        newOrExisting: "Existing",
        clientType: "Existing",
        area: "",
        metTo: "",
        designation: "",
        enquiryMode: "",
        orderGenerated: 0,
        salesInvoiced: 0,
        sales: 0,
        segment: "",
        salespersonSalesInvoiced: 0,
        salespersonPoReceived: 0,
        poReceived: 0,
      };

  return {
    ...base,
    customerId: base.customerId || master.customerId || "",
    customerName: name,
    clientType: normalizeClientType(base.clientType || master.clientType || "", "Existing"),
    area: toTitleCase(base.area || master.area),
    metTo: toTitleCase(base.metTo || master.metTo),
    designation: toTitleCase(base.designation || master.designation),
    segment: toTitleCase(base.segment || master.segment),
    orderGenerated: base.orderGenerated ?? base.salespersonSalesInvoiced ?? 0,
    salespersonSalesInvoiced: base.salespersonSalesInvoiced ?? base.orderGenerated ?? 0,
    poReceived: base.salespersonPoReceived ?? base.poReceived ?? 0,
    salesInvoiced: 0,
  };
}

async function normalizeDailyReportRows(
  rows,
  userId,
  { createMissingCustomers = true, createAllCustomers = false, includeSalesInvoiced = true } = {}
) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const cleanedRows = safeRows
    .map((r) => {
      const customerName = toTitleCase(r?.customerName || r?.customer || r?.name);
      const rowId = r?._id != null ? String(r._id).trim() : "";
      const salesInvoicedValue = includeSalesInvoiced
        ? Number(r?.salesInvoiced ?? r?.sales ?? r?.salesAmount ?? r?.invoiceAmount ?? 0)
        : 0;
      const orderGenerated = Number(r?.orderGenerated ?? r?.salespersonSalesInvoiced ?? r?.order ?? r?.orderValue ?? r?.orderAmount ?? 0);
      const salespersonSalesInvoiced = Number(r?.salespersonSalesInvoiced ?? orderGenerated ?? salesInvoicedValue ?? 0);
      return {
        ...(rowId ? { _id: rowId } : {}),
        customerName,
        newOrExisting: String(r?.newOrExisting || r?.type || "").trim() === "New" ? "New" : "Existing",
        area: toTitleCase(r?.area || r?.location),
        metTo: toTitleCase(r?.metTo || r?.met_to),
        designation: toTitleCase(r?.designation || r?.designationName),
        enquiryMode: normalizeEnquiryMode(r?.enquiryMode || r?.mode || r?.modeOfEnquiry),
        orderGenerated,
        salesInvoiced: salesInvoicedValue,
        salespersonSalesInvoiced,
        segment: toTitleCase(r?.segment || r?.segmentName),
        salespersonPoReceived: Number(r?.salespersonPoReceived ?? r?.poReceived ?? r?.collection ?? r?.collected ?? 0),
        poReceived: Number(r?.poReceived ?? r?.salespersonPoReceived ?? r?.collection ?? r?.collected ?? 0),
        salesInvoiceDate: normalizeDateField(r?.salesInvoiceDate || r?.invoiceDate || r?.salesInvoicedDate),
        collectionDate: normalizeDateField(r?.collectionDate || r?.poReceivedDate || r?.receivedDate),
      };
    })
    .filter((r) => r.customerName);

  if (createMissingCustomers && userId) {
    const rowsToCreate = createAllCustomers
      ? cleanedRows
      : cleanedRows.filter((r) => r.newOrExisting === "New");

    for (const row of rowsToCreate) {
      await upsertCustomerByName(Customer, {
        name: row.customerName,
        clientType: row.clientType || row.newOrExisting || "Existing",
        area: row.area || "",
        metTo: row.metTo || "",
        designation: row.designation || "",
        segment: row.segment || "",
      }, {
        createdBy: userId,
      });
    }
  }

  const customerLookup = await buildCustomerLookup();

  return cleanedRows.map((row) => {
    const found = customerLookup.get(normalizeCustomerKey(row.customerName));
    return {
      ...row,
      customerId: row.customerId || found?.customerId || "",
    };
  });
}

function rowIdentityKey(row = {}) {
  return [
    String(row?._id || "").trim(),
    normalizeCustomerKey(row?.customerName),
    normalizeCustomerKey(row?.area),
    normalizeCustomerKey(row?.metTo),
    normalizeCustomerKey(row?.designation),
    Number(row?.orderGenerated || row?.order || 0),
    normalizeCustomerKey(row?.segment),
  ].join("|");
}

function mergeSalespersonFinancials(existingRows, incomingRows) {
  const existingMap = new Map();
  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    existingMap.set(rowIdentityKey(row), row);
    if (row?._id) existingMap.set(String(row._id), row);
  }

  return (Array.isArray(incomingRows) ? incomingRows : []).map((row) => {
    const existing = existingMap.get(String(row?._id || "")) || existingMap.get(rowIdentityKey(row)) || null;
    if (!existing) return row;

    const salespersonSalesInvoiced =
      Number(row?.salespersonSalesInvoiced ?? row?.orderGenerated ?? 0) ||
      Number(existing?.salespersonSalesInvoiced ?? existing?.orderGenerated ?? 0);
    const salespersonPoReceived =
      Number(row?.salespersonPoReceived || row?.poReceived || 0) ||
      Number(existing?.salespersonPoReceived || existing?.poReceived || existing?.collection || existing?.collected || 0);
    const existingPoTotal = Number(existing?.poReceived || existing?.collection || existing?.collected || 0);
    const existingSalespersonPo = Number(existing?.salespersonPoReceived || 0);
    const adminCollectionDelta = Math.max(existingPoTotal - existingSalespersonPo, 0);
    const poReceived = salespersonPoReceived + adminCollectionDelta;
    const salesInvoiceDate = normalizeDateField(
      row?.salesInvoiceDate || row?.invoiceDate || row?.salesInvoicedDate || existing?.salesInvoiceDate
    );
    const collectionDate = normalizeDateField(
      row?.collectionDate || row?.poReceivedDate || row?.receivedDate || existing?.collectionDate
    );

    return {
      ...row,
      _id: row?._id || existing?._id,
      orderGenerated: salespersonSalesInvoiced,
      salespersonSalesInvoiced,
      salespersonPoReceived,
      salesInvoiced: 0,
      sales: 0,
      poReceived,
      salesInvoiceDate,
      collectionDate,
    };
  });
}

exports.upsertMyDailyReport = async (req, res) => {
  try {
    const userId = req.user.id;
    const { reportDateKey, openingKm, closingKm, rows, startLocation, locationTrail } = req.body;

    if (!isValidDateKey(reportDateKey)) {
      return res.status(400).json({ message: "reportDateKey must be YYYY-MM-DD" });
    }

    const open = Number(openingKm || 0);
    const close = Number(closingKm || 0);

    if (open < 0 || close < 0) {
      return res.status(400).json({ message: "KM cannot be negative" });
    }
    if (close < open) {
      return res.status(400).json({ message: "Closing KM cannot be less than Opening KM" });
    }

    const existingDoc = await DailyCustomerReport.findOne({ userId, reportDateKey }).select("rows").lean();
    const cleanedRows = await normalizeDailyReportRows(rows, userId, { includeSalesInvoiced: false });
    const mergedRows = existingDoc?.rows?.length
      ? mergeSalespersonFinancials(existingDoc.rows, cleanedRows)
      : cleanedRows;
    const duplicateRow = findDuplicateCustomerRow(mergedRows);
    if (duplicateRow) {
      return res.status(400).json({ message: buildDuplicateCustomerMessage(duplicateRow) });
    }
    const snapshot = await buildSalespersonSnapshot(userId);

    let cleanStartLocation = null;
    if (startLocation && Number.isFinite(Number(startLocation.lat)) && Number.isFinite(Number(startLocation.lng))) {
      const lat = Number(startLocation.lat);
      const lng = Number(startLocation.lng);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        cleanStartLocation = {
          lat,
          lng,
          accuracy: Number.isFinite(Number(startLocation.accuracy)) ? Number(startLocation.accuracy) : null,
          capturedAt: startLocation.capturedAt ? new Date(startLocation.capturedAt) : new Date()
        };
      }
    }

    let cleanLocationTrail = [];
    if (Array.isArray(locationTrail)) {
      cleanLocationTrail = locationTrail
        .map((p) => {
          const lat = Number(p?.lat);
          const lng = Number(p?.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
          return {
            lat,
            lng,
            accuracy: Number.isFinite(Number(p?.accuracy)) ? Number(p.accuracy) : null,
            capturedAt: p?.capturedAt ? new Date(p.capturedAt) : new Date()
          };
        })
        .filter(Boolean)
        .slice(-1000);
    }

    const setObj = {
      openingKm: open,
      closingKm: close,
      rows: mergedRows,
    };

    if (cleanStartLocation) setObj.startLocation = cleanStartLocation;
    if (Array.isArray(locationTrail)) setObj.locationTrail = cleanLocationTrail;

    const doc = await DailyCustomerReport.findOneAndUpdate(
      { userId, reportDateKey },
      {
        $set: setObj,
        $setOnInsert: {
          salespersonName: snapshot.salespersonName,
          salespersonEmail: snapshot.salespersonEmail,
        },
      },
      { new: true, upsert: true }
    );

    const rebuilt = await rebuildFinanceTotalsForReport(doc);
    return res.json(rebuilt?.report || doc);
  } catch (e) {
    // duplicate key safe
    if (e.code === 11000) {
      return res.status(409).json({ message: "Report already exists for this date. Please refresh and edit." });
    }
    return res.status(500).json({ message: e.message });
  }
};

exports.getMyDailyReportByDate = async (req, res) => {
  try {
    const userId = req.user.id;
    const { date } = req.query; // YYYY-MM-DD

    if (!isValidDateKey(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }

    const doc = await DailyCustomerReport.findOne({ userId, reportDateKey: date });
    if (doc) {
      const entries = await getFinanceEntriesForReport(doc);
      doc.rows = applyFinanceTotalsToRows(doc.rows, entries);
    }
    return res.json(doc || null);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.getMyCustomerVisitTemplate = async (req, res) => {
  try {
    const userId = req.user.id;
    const customerName = String(req.query.customerName || req.query.name || "").trim();

    if (!customerName) {
      return res.status(400).json({ message: "customerName required" });
    }

    const template = await buildLatestCustomerVisitTemplate(userId, customerName);
    return res.json(template || null);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load customer template" });
  }
};

exports.adminUpdateDailyReport = async (req, res) => {
  try {
    const { reportDateKey, userId, rows } = req.body;

    if (!isValidDateKey(reportDateKey)) {
      return res.status(400).json({ message: "reportDateKey must be YYYY-MM-DD" });
    }
    if (!userId) {
      return res.status(400).json({ message: "userId required" });
    }
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ message: "rows required" });
    }

    const doc = await DailyCustomerReport.findOne({ userId, reportDateKey });
    if (!doc) {
      return res.status(404).json({ message: "Daily report not found" });
    }
    const previousRowsById = new Map(
      (Array.isArray(doc.rows) ? doc.rows : [])
        .filter((row) => row && row._id)
        .map((row) => [String(row._id), row])
    );

    const cleanedRows = await normalizeDailyReportRows(rows, userId, {
      createMissingCustomers: false,
      createAllCustomers: false,
    });
    if (!cleanedRows.length) {
      return res.status(400).json({ message: "No valid client rows found" });
    }
    const duplicateRow = findDuplicateCustomerRow(cleanedRows);
    if (duplicateRow) {
      return res.status(400).json({ message: buildDuplicateCustomerMessage(duplicateRow) });
    }

    doc.rows = cleanedRows;
    await doc.save();

    // Keep the shared client master in sync with admin corrections.
    for (const row of cleanedRows) {
      const rowId = String(row?._id || "").trim();
      const previousRow = rowId ? previousRowsById.get(rowId) : null;
      const payload = {
        name: row.customerName,
        clientType: row.newOrExisting || "Existing",
        area: row.area || "",
        metTo: row.metTo || "",
        designation: row.designation || "",
        segment: row.segment || "",
      };

      if (previousRow && normalizeCustomerKey(previousRow.customerName) !== normalizeCustomerKey(row.customerName)) {
        await upsertCustomerByPreviousName(Customer, previousRow.customerName, payload, { createdBy: req.user.id });
      } else {
        await upsertCustomerByName(Customer, payload, { createdBy: req.user.id });
      }
    }

    return res.json({
      message: "Daily report updated successfully",
      report: doc,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to update daily report" });
  }
};

exports.adminListFinanceEntries = async (req, res) => {
  try {
    const { userId, reportDateKey } = req.query;
    const q = {};
    if (userId) q.userId = userId;
    if (reportDateKey && isValidDateKey(String(reportDateKey))) q.reportDateKey = reportDateKey;

    const entries = await DailyReportFinanceEntry.find(q)
      .sort({ entryDate: 1, createdAt: 1 })
      .lean();

    return res.json({ items: entries });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load finance entries" });
  }
};

exports.adminAddFinanceEntry = async (req, res) => {
  try {
    const {
      reportDateKey,
      userId,
      rowId,
      customerName,
      type,
      amount,
      entryDate,
      note,
    } = req.body;

    if (!isValidDateKey(reportDateKey)) {
      return res.status(400).json({ message: "reportDateKey must be YYYY-MM-DD" });
    }
    if (!userId) return res.status(400).json({ message: "userId required" });
    if (!rowId) return res.status(400).json({ message: "rowId required" });
    if (!String(customerName || "").trim()) return res.status(400).json({ message: "customerName required" });
    if (!["INVOICE", "COLLECTION"].includes(String(type || "").trim())) {
      return res.status(400).json({ message: "type must be INVOICE or COLLECTION" });
    }
    const amt = Number(amount || 0);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: "amount must be greater than 0" });
    }
    if (!isValidDateKey(String(entryDate || ""))) {
      return res.status(400).json({ message: "entryDate must be YYYY-MM-DD" });
    }

    const reportDoc = await DailyCustomerReport.findOne({ userId, reportDateKey });
    if (!reportDoc) return res.status(404).json({ message: "Daily report not found" });

    const row = (Array.isArray(reportDoc.rows) ? reportDoc.rows : []).find((r) => String(r?._id || "") === String(rowId));
    if (!row) return res.status(404).json({ message: "Client row not found in report" });
    const salespersonSnapshot = {
      salespersonName: String(reportDoc.salespersonName || "").trim(),
      salespersonEmail: String(reportDoc.salespersonEmail || "").trim(),
    };

    const createdBy = req.user.id;
    const entry = await DailyReportFinanceEntry.create({
      userId,
      salespersonName: salespersonSnapshot.salespersonName,
      salespersonEmail: salespersonSnapshot.salespersonEmail,
      reportDateKey,
      dailyReportId: reportDoc._id,
      rowId,
      customerName: String(customerName).trim(),
      type: String(type).trim(),
      amount: amt,
      entryDate: String(entryDate).trim(),
      note: String(note || "").trim(),
      createdBy,
    });

    const rebuilt = await rebuildFinanceTotalsForReport(reportDoc);
    return res.json({
      message: "Finance entry added successfully",
      entry,
      report: rebuilt?.report || reportDoc,
      entries: rebuilt?.entries || [],
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to add finance entry" });
  }
};

exports.adminDeleteFinanceEntry = async (req, res) => {
  try {
    const entry = await DailyReportFinanceEntry.findById(req.params.id).lean();
    if (!entry) return res.status(404).json({ message: "Finance entry not found" });

    const reportDoc = await DailyCustomerReport.findById(entry.dailyReportId);
    if (!reportDoc) return res.status(404).json({ message: "Daily report not found" });

    await DailyReportFinanceEntry.deleteOne({ _id: entry._id });
    const rebuilt = await rebuildFinanceTotalsForReport(reportDoc);
    return res.json({
      message: "Finance entry deleted successfully",
      report: rebuilt?.report || reportDoc,
      entries: rebuilt?.entries || [],
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to delete finance entry" });
  }
};

exports.adminUpdateNewCustomerLastDate = async (req, res) => {
  try {
    const {
      userId,
      periodType = "MONTH",
      periodKey,
      customerName,
      area,
      segment,
      lastDateOfSales,
    } = req.body;

    if (!userId) return res.status(400).json({ message: "userId required" });
    if (!periodKey) return res.status(400).json({ message: "periodKey required" });
    if (!String(customerName || "").trim()) return res.status(400).json({ message: "customerName required" });
    if (!isValidDateKey(String(lastDateOfSales || ""))) {
      return res.status(400).json({ message: "lastDateOfSales must be YYYY-MM-DD" });
    }

    const { to } = getRange(periodType, periodKey);
    const customerLookup = await buildCustomerLookup();
    const historyDocs = await DailyCustomerReport.find({
      userId: new mongoose.Types.ObjectId(userId),
      reportDateKey: { $lte: to },
    })
      .select("_id rows reportDateKey")
      .sort({ reportDateKey: -1, updatedAt: -1 })
      .lean();

    const targetName = normalizeCustomerKey(customerName);
    const targetArea = normalizeCustomerKey(area);
    const targetSegment = normalizeCustomerKey(segment);
    let match = null;

    for (const doc of Array.isArray(historyDocs) ? historyDocs : []) {
      const rows = Array.isArray(doc?.rows) ? doc.rows : [];
      for (const row of rows) {
        const normalizedRow = enrichCustomerRow(row, customerLookup);
        if (!normalizedRow.customerName) continue;
        if (normalizeCustomerKey(normalizedRow.customerName) !== targetName) continue;
        if (targetArea && normalizeCustomerKey(normalizedRow.area) !== targetArea) continue;
        if (targetSegment && normalizeCustomerKey(normalizedRow.segment) !== targetSegment) continue;

        const hasSales =
          Number(
            normalizedRow.salespersonSalesInvoiced ||
              normalizedRow.orderGenerated ||
              normalizedRow.salesInvoiced ||
              normalizedRow.sales ||
              0
          ) > 0;
        if (!hasSales) continue;

        match = {
          reportId: String(doc?._id || ""),
          rowId: String(normalizedRow._id || normalizedRow.rowId || row?._id || "").trim(),
          reportDateKey: String(doc?.reportDateKey || "").trim(),
        };
        break;
      }
      if (match) break;
    }

    if (!match?.reportId || !match?.rowId) {
      return res.status(404).json({ message: "Matching sales row not found" });
    }

    await DailyCustomerReport.updateOne(
      { _id: match.reportId, "rows._id": new mongoose.Types.ObjectId(match.rowId) },
      {
        $set: {
          "rows.$.salesInvoiceDate": String(lastDateOfSales).trim(),
        },
      }
    );

    return res.json({
      message: "Last date of sales updated successfully",
      reportDateKey: match.reportDateKey,
      rowId: match.rowId,
      lastDateOfSales: String(lastDateOfSales).trim(),
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to update last date of sales" });
  }
};

exports.listMyDailyReports = async (req, res) => {
  try {
    const userId = req.user.id;
    const { from, to } = req.query; // YYYY-MM-DD

    const q = { userId };
    if (from && isValidDateKey(from)) q.reportDateKey = { ...(q.reportDateKey || {}), $gte: from };
    if (to && isValidDateKey(to)) q.reportDateKey = { ...(q.reportDateKey || {}), $lte: to };

    const docs = await DailyCustomerReport.find(q).sort({ reportDateKey: -1 });
    return res.json(docs);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

// Admin list (optional but useful)
exports.adminListDailyReports = async (req, res) => {
  try {
    const { userId, date } = req.query; // filter optional

    const q = {};
    if (userId) q.userId = userId;
    if (date && isValidDateKey(date)) q.reportDateKey = date;

    const docs = await DailyCustomerReport.find(q)
      .sort({ reportDateKey: -1 })
      .populate("userId", "name email");

    return res.json(docs);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};


/**
 * Admin: list daily reports in date range (view-only)
 * GET /api/reports/daily-customer/admin/list?userId=&from=&to=
 */
exports.adminListDailyReportsRange = async (req, res) => {
  try {
    const { userId, from, to } = req.query;
    const parsedLimit = Number(req.query.limit || 200);
    const maxLimit = 5000;
    const safeLimit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, maxLimit))
      : 200;
    if (from && !isValidDateKey(String(from))) {
      return res.status(400).json({ message: "Invalid 'from' date. Use YYYY-MM-DD" });
    }
    if (to && !isValidDateKey(String(to))) {
      return res.status(400).json({ message: "Invalid 'to' date. Use YYYY-MM-DD" });
    }
    if (from && to && String(from) > String(to)) {
      return res.status(400).json({ message: "'from' date cannot be after 'to' date" });
    }

    const customerLookup = await buildCustomerLookup();

    const filter = {};
    if (userId) filter.userId = userId;

    if (from || to) {
      filter.reportDateKey = {};
      if (from) filter.reportDateKey.$gte = String(from);
      if (to) filter.reportDateKey.$lte = String(to);
    }

    const list = await DailyCustomerReport.find(filter)
      .select("userId salespersonName salespersonEmail reportDateKey openingKm closingKm startLocation locationTrail rows")
      .sort({ reportDateKey: -1 })
      .limit(safeLimit)
      .populate("userId", "name email")
      .lean();

    const reportIds = list.map((r) => String(r?._id || "")).filter(Boolean);
    const financeEntries = reportIds.length
      ? await DailyReportFinanceEntry.find({ dailyReportId: { $in: reportIds } })
          .sort({ entryDate: 1, createdAt: 1 })
          .select("dailyReportId rowId type amount entryDate createdAt")
          .lean()
      : [];
    const financeByReport = indexFinanceEntriesByReport(financeEntries);

    // Totals for summary
    let totalNetKm = 0;
    let totalOrder = 0;
    let totalSalesInvoiced = 0;
    let totalPO = 0;
    let totalRows = 0;

    const mapped = list.map((r) => {
      const opening = Number(r.openingKm || 0);
      const closing = Number(r.closingKm || 0);
      const netKm = closing - opening;

      const rows = Array.isArray(r.rows) ? r.rows : [];
      const financeRows = financeByReport.get(String(r._id || "")) || [];
      const currentRows = applyFinanceTotalsToRows(rows, financeRows);
      const enrichedRows = currentRows.map((x) => enrichCustomerRow(x, customerLookup));
      const orderSum = enrichedRows.reduce((a, x) => a + Number(x.orderGenerated || 0), 0);
    const salesInvoicedSum = enrichedRows.reduce((a, x) => a + Number(x.salesInvoiced || x.sales || 0), 0);
      const poSum = enrichedRows.reduce((a, x) => a + readCollectionAmount(x), 0);
      const clientVisits = enrichedRows
        .map((x) => ({
          customerName: String(x?.customerName || "").trim(),
          area: String(x?.area || "").trim(),
          segment: String(x?.segment || "").trim(),
        }))
        .filter((x) => x.customerName);

      const uniqClientMap = new Map();
      for (const c of clientVisits) {
        const k = `${c.customerName.toLowerCase()}|${c.area.toLowerCase()}`;
        if (!uniqClientMap.has(k)) uniqClientMap.set(k, c);
      }
      const uniqClientVisits = Array.from(uniqClientMap.values());

      totalNetKm += netKm;
      totalOrder += orderSum;
      totalSalesInvoiced += salesInvoicedSum;
      totalPO += poSum;
      totalRows += rows.length;

      return {
        _id: r._id,
        userId: r.userId,
        salespersonName: r.salespersonName || "",
        salespersonEmail: r.salespersonEmail || "",
        reportDateKey: r.reportDateKey,
        openingKm: r.openingKm,
        closingKm: r.closingKm,
        startLocation: r.startLocation || null,
        locationTrail: Array.isArray(r.locationTrail)
          ? r.locationTrail.map((p) => ({
              lat: Number(p?.lat),
              lng: Number(p?.lng),
              accuracy: Number(p?.accuracy || 0),
              capturedAt: p?.capturedAt || null,
            }))
          : [],
        netKm,
        rowsCount: rows.length,
        orderSum,
        salesInvoicedSum,
        poSum,
        clientVisits: uniqClientVisits,
        // keep row-level values for combined customer analytics screens
        rows: enrichedRows,
      };
    });

    res.json({
      items: mapped,
      summary: {
        count: mapped.length,
        totalRows,
        totalNetKm,
        totalOrder,
        totalSalesInvoiced,
        totalPO,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load admin reports" });
  }
};

/**
 * Admin: export CSV (view-only)
 * GET /api/reports/daily-customer/admin/export.csv?userId=&from=&to=
 */
exports.adminExportDailyReportsCSV = async (req, res) => {
  try {
    const { userId, from, to } = req.query;
    if (from && !isValidDateKey(String(from))) {
      return res.status(400).json({ message: "Invalid 'from' date. Use YYYY-MM-DD" });
    }
    if (to && !isValidDateKey(String(to))) {
      return res.status(400).json({ message: "Invalid 'to' date. Use YYYY-MM-DD" });
    }
    if (from && to && String(from) > String(to)) {
      return res.status(400).json({ message: "'from' date cannot be after 'to' date" });
    }

    const customerLookup = await buildCustomerLookup();

    const filter = {};
    if (userId) filter.userId = userId;

    if (from || to) {
      filter.reportDateKey = {};
      if (from) filter.reportDateKey.$gte = String(from);
      if (to) filter.reportDateKey.$lte = String(to);
    }

    const list = await DailyCustomerReport.find(filter)
      .select("userId salespersonName salespersonEmail reportDateKey openingKm closingKm startLocation locationTrail rows")
      .sort({ reportDateKey: -1 })
      .limit(2000)
      .lean();

    const reportIds = list.map((r) => String(r?._id || "")).filter(Boolean);
    const financeEntries = reportIds.length
      ? await DailyReportFinanceEntry.find({ dailyReportId: { $in: reportIds } })
          .sort({ entryDate: 1, createdAt: 1 })
          .select("dailyReportId rowId type amount entryDate createdAt")
          .lean()
      : [];
    const financeByReport = indexFinanceEntriesByReport(financeEntries);

    // CSV header
    const header = [
      "reportDate",
      "salespersonUserId",
      "openingKm",
      "closingKm",
      "netKm",
      "startLat",
      "startLng",
      "startAccuracy",
      "startCapturedAt",
      "trackPoints",
      "customerName",
      "newOrExisting",
      "area",
      "metTo",
      "designation",
      "orderGenerated",
      "salesInvoiced",
      "salesInvoiceDate",
      "segment",
      "poReceived",
      "collectionDate",
    ];

    const rows = [header.join(",")];

    // Flatten each report rows into CSV rows
    for (const r of list) {
      const opening = Number(r.openingKm || 0);
      const closing = Number(r.closingKm || 0);
      const netKm = closing - opening;
      const startLat = Number(r?.startLocation?.lat);
      const startLng = Number(r?.startLocation?.lng);
      const startAccuracy = Number(r?.startLocation?.accuracy);
      const startCapturedAt = r?.startLocation?.capturedAt
        ? new Date(r.startLocation.capturedAt).toISOString()
        : "";
      const trackPoints = Array.isArray(r?.locationTrail) ? r.locationTrail.length : 0;
      const financeRows = financeByReport.get(String(r._id || "")) || [];
      const currentRows = applyFinanceTotalsToRows(Array.isArray(r.rows) ? r.rows : [], financeRows);
      const items = currentRows.map((it) => enrichCustomerRow(it, customerLookup));

      if (!items.length) {
        // still output one line per report
        rows.push(
          [
            r.reportDateKey,
            r.userId,
            opening,
            closing,
            netKm,
            Number.isFinite(startLat) ? startLat : "",
            Number.isFinite(startLng) ? startLng : "",
            Number.isFinite(startAccuracy) ? startAccuracy : "",
            startCapturedAt,
            trackPoints,
            "", "", "", "", "", "", "", "", ""
          ].join(",")
        );
        continue;
      }

      for (const it of items) {
        const safe = (v) => {
          const s = String(v ?? "").replace(/"/g, '""');
          // wrap in quotes if contains comma
          return s.includes(",") ? `"${s}"` : s;
        };

        rows.push(
          [
            safe(r.reportDateKey),
            safe(r.userId),
            opening,
            closing,
            netKm,
            Number.isFinite(startLat) ? startLat : "",
            Number.isFinite(startLng) ? startLng : "",
            Number.isFinite(startAccuracy) ? startAccuracy : "",
            safe(startCapturedAt),
            trackPoints,
            safe(it.customerName),
            safe(it.newOrExisting),
            safe(it.area),
            safe(it.metTo),
            safe(it.designation),
            Number(it.orderGenerated || 0),
            Number(it.salesInvoiced || it.sales || 0),
            safe(it.salesInvoiceDate || ""),
            safe(it.segment),
            Number(it.poReceived || 0),
            safe(it.collectionDate || ""),
          ].join(",")
        );
      }
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=daily-reports.csv");
    res.send(rows.join("\n"));
  } catch (e) {
    res.status(500).json({ message: e.message || "Export failed" });
  }
};
