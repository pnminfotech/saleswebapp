// controllers/reportController.js
const mongoose = require("mongoose");

const DailyCustomerReport = require("../models/DailyCustomerReport");
const DailyReportFinanceEntry = require("../models/DailyReportFinanceEntry");
const Customer = require("../models/Customer");
const Target = require("../models/Target");
const User = require("../models/User");
const Segment = require("../models/Segment");
const { getRange } = require("../utils/period");
const { resolveTargetRows } = require("../utils/targetRollup");

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function toTitleCase(value) {
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function parseMonthKey(monthKey) {
  const match = String(monthKey || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error("monthKey must be in YYYY-MM format");
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!year || month < 1 || month > 12) throw new Error("monthKey must be in YYYY-MM format");
  return { year, month };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function monthKeyToQuarterKey(monthKey) {
  const { year, month } = parseMonthKey(monthKey);
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `${year}-Q${quarter}`;
}

function monthKeyToYearKey(monthKey) {
  return String(monthKey || "").slice(0, 4);
}

function monthKeysInRange(fromKey, toKey) {
  const from = new Date(`${fromKey}T00:00:00`);
  const to = new Date(`${toKey}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return [];

  const current = new Date(from.getFullYear(), from.getMonth(), 1);
  const end = new Date(to.getFullYear(), to.getMonth(), 1);
  const keys = [];

  while (current <= end) {
    keys.push(`${current.getFullYear()}-${pad2(current.getMonth() + 1)}`);
    current.setMonth(current.getMonth() + 1);
  }

  return keys;
}

function quarterKeysForYear(yearKey) {
  const year = String(yearKey || "").trim();
  if (!year) return [];
  return ["Q1", "Q2", "Q3", "Q4"].map((q) => `${year}-${q}`);
}

function buildVarianceCell(targetValue, actualValue) {
  const target = Number(targetValue || 0);
  const actual = Number(actualValue || 0);
  const achieved = actual >= target;
  const amount = achieved ? Math.max(actual - target, 0) : Math.max(target - actual, 0);
  const percent = target ? Math.round((actual / target) * 100) : 0;

  return {
    status: achieved ? (amount > 0 ? "achieved" : "met") : "pending",
    amount,
    percent,
    target,
    actual,
  };
}

function buildSegmentColumns(segmentDocs, ...maps) {
  const columns = [];
  const seen = new Set();

  for (const segment of Array.isArray(segmentDocs) ? segmentDocs : []) {
    const key = normalizeKey(segment?.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    columns.push({
      key,
      label: String(segment?.name || "").trim(),
    });
  }

  const extraKeys = new Set();
  for (const map of maps) {
    if (!map) continue;
    for (const key of map.keys()) {
      if (!seen.has(key)) extraKeys.add(key);
    }
  }

  Array.from(extraKeys)
    .sort((a, b) => a.localeCompare(b))
    .forEach((key) => {
      seen.add(key);
      columns.push({
        key,
        label: toTitleCase(key),
      });
    });

  return columns;
}

async function buildCustomerLookup() {
  const customers = await Customer.find({}).select("name area segment").lean();
  const map = new Map();

  for (const customer of customers) {
    const key = String(customer?.name || "").trim().toLowerCase();
    if (!key || map.has(key)) continue;
    map.set(key, {
      area: String(customer?.area || "").trim(),
      segment: String(customer?.segment || "").trim(),
    });
  }

  return map;
}

function enrichCustomerRow(row, customerLookup) {
  const rowId = String(row?._id || row?.rowId || "").trim();
  const name = String(row?.customerName || "").trim();
  const found = customerLookup.get(name.toLowerCase()) || {};
  const orderGenerated = Number(
    row?.orderGenerated ?? row?.order ?? row?.orderValue ?? row?.orderAmount ?? 0
  );
  const salesInvoiced = Number(
    row?.salesInvoiced ?? row?.sales ?? row?.salesAmount ?? row?.invoiceAmount ?? 0
  );
  const poReceived = Number(row?.poReceived ?? row?.collection ?? row?.collected ?? 0);

  return {
    _id: rowId,
    rowId,
    customerName: name,
    newOrExisting: row?.newOrExisting === "New" ? "New" : "Existing",
    area: String(row?.area || found?.area || "").trim(),
    metTo: String(row?.metTo || "").trim(),
    designation: String(row?.designation || "").trim(),
    enquiryMode: String(row?.enquiryMode || "").trim(),
    orderGenerated,
    salesInvoiced,
    sales: salesInvoiced,
    segment: String(row?.segment || found?.segment || "").trim(),
    poReceived,
    salesInvoiceDate: String(row?.salesInvoiceDate || row?.invoiceDate || row?.salesInvoicedDate || "").trim(),
    collectionDate: String(row?.collectionDate || row?.poReceivedDate || row?.receivedDate || "").trim(),
  };
}

async function aggregateSegmentActuals({ from, to, userId }) {
  const match = {
    reportDateKey: { $gte: from, $lte: to },
  };

  if (userId) {
    match.userId = new mongoose.Types.ObjectId(userId);
  }

  const list = await DailyCustomerReport.aggregate([
    { $match: match },
    { $unwind: "$rows" },
    {
      $project: {
        segmentKey: {
          $toLower: {
            $trim: {
              input: { $ifNull: ["$rows.segment", ""] },
            },
          },
        },
        salesInvoiced: {
          $ifNull: ["$rows.salesInvoiced", { $ifNull: ["$rows.sales", 0] }],
        },
      },
    },
    { $match: { segmentKey: { $ne: "" } } },
    {
      $group: {
        _id: "$segmentKey",
        salesInvoiced: { $sum: "$salesInvoiced" },
      },
    },
  ]);

  return new Map(list.map((x) => [String(x._id || ""), Number(x.salesInvoiced || 0)]));
}

async function aggregateSegmentCustomerActuals({ from, to, userId, segmentName }) {
  const segmentKey = normalizeKey(segmentName);
  if (!segmentKey) return [];

  const match = {
    reportDateKey: { $gte: from, $lte: to },
  };

  if (userId) {
    match.userId = new mongoose.Types.ObjectId(userId);
  }

  const list = await DailyCustomerReport.aggregate([
    { $match: match },
    { $unwind: "$rows" },
    {
      $project: {
        customerName: {
          $trim: {
            input: { $ifNull: ["$rows.customerName", ""] },
          },
        },
        area: {
          $trim: {
            input: { $ifNull: ["$rows.area", ""] },
          },
        },
        segmentKey: {
          $toLower: {
            $trim: {
              input: { $ifNull: ["$rows.segment", ""] },
            },
          },
        },
        salesInvoiced: {
          $ifNull: ["$rows.salesInvoiced", { $ifNull: ["$rows.sales", 0] }],
        },
      },
    },
    {
      $match: {
        customerName: { $ne: "" },
        segmentKey,
      },
    },
    {
      $group: {
        _id: {
          customerKey: { $toLower: "$customerName" },
          area: "$area",
        },
        customerName: { $first: "$customerName" },
        area: { $first: "$area" },
        salesInvoiced: { $sum: "$salesInvoiced" },
      },
    },
    { $sort: { customerName: 1 } },
  ]);

  return list.map((x) => ({
    key: String(x?._id?.customerKey || "").trim(),
    customerName: String(x.customerName || "").trim(),
    area: String(x.area || "").trim(),
    salesInvoiced: Number(x.salesInvoiced || 0),
  }));
}

async function aggregateSegmentTargetTotal({ periodType, periodKey, userId, segmentId }) {
  const q = {
    periodType,
    periodKey,
    segmentId: new mongoose.Types.ObjectId(segmentId),
  };

  if (userId) {
    q.userId = new mongoose.Types.ObjectId(userId);
  }

  const docs = await Target.find(q).lean();
  return docs.reduce((acc, doc) => acc + Number(doc?.salesTarget || 0), 0);
}

function allocateTargetsByShare(actualValues, totalTarget) {
  const actuals = Array.isArray(actualValues) ? actualValues.map((v) => Number(v || 0)) : [];
  const target = Number(totalTarget || 0);
  const totalActual = actuals.reduce((acc, value) => acc + value, 0);
  if (!actuals.length || !target || !totalActual) return actuals.map(() => 0);

  const raw = actuals.map((value) => (value / totalActual) * target);
  const base = raw.map((value) => Math.floor(value));
  let remainder = Math.round(target - base.reduce((acc, value) => acc + value, 0));

  const ranked = raw
    .map((value, index) => ({ index, fraction: value - base[index] }))
    .sort((a, b) => {
      if (b.fraction !== a.fraction) return b.fraction - a.fraction;
      return a.index - b.index;
    });

  const result = [...base];
  let cursor = 0;
  while (remainder > 0 && ranked.length) {
    const pick = ranked[cursor % ranked.length];
    result[pick.index] += 1;
    remainder -= 1;
    cursor += 1;
  }

  return result;
}

exports.adminSegmentWiseCustomerReport = async (req, res) => {
  try {
    const monthKey = String(req.query.monthKey || req.query.periodKey || "").trim();
    const userId = String(req.query.userId || "").trim();
    const segmentInput = String(req.query.segmentId || req.query.segmentName || "").trim();

    if (!monthKey) {
      return res.status(400).json({ message: "monthKey required" });
    }
    if (!segmentInput) {
      return res.status(400).json({ message: "segmentId required" });
    }
    if (userId && !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId" });
    }
    const segmentDoc = mongoose.Types.ObjectId.isValid(segmentInput)
      ? await Segment.findById(segmentInput).lean()
      : await Segment.findOne({ name: segmentInput.replace(/^segment-/i, "") }).lean();
    if (!segmentDoc) {
      return res.status(404).json({ message: "Segment not found" });
    }

    const { from: monthFrom, to: monthTo } = getRange("MONTH", monthKey);
    const quarterKey = monthKeyToQuarterKey(monthKey);
    const yearKey = monthKeyToYearKey(monthKey);
    const { from: quarterFrom, to: quarterTo } = getRange("QUARTER", quarterKey);
    const { from: yearFrom, to: yearTo } = getRange("YEAR", yearKey);
    const quarterMonthKeys = monthKeysInRange(quarterFrom, quarterTo);
    const yearMonthKeys = monthKeysInRange(yearFrom, yearTo);
    const yearQuarterKeys = quarterKeysForYear(yearKey);
    const segmentName = String(segmentDoc.name || "").trim();

    const [
      monthActualRows,
      quarterActualRows,
      yearActualRows,
      monthTargetTotal,
      quarterTargetDirect,
      yearTargetDirect,
      quarterTargetFallback,
      yearTargetFallbackFromQuarters,
      yearTargetFallbackFromMonths,
    ] = await Promise.all([
      aggregateSegmentCustomerActuals({ from: monthFrom, to: monthTo, userId: userId || "", segmentName }),
      aggregateSegmentCustomerActuals({ from: quarterFrom, to: quarterTo, userId: userId || "", segmentName }),
      aggregateSegmentCustomerActuals({ from: yearFrom, to: yearTo, userId: userId || "", segmentName }),
      aggregateSegmentTargetTotal({ periodType: "MONTH", periodKey: monthKey, userId: userId || "", segmentId: segmentDoc._id }),
      aggregateSegmentTargetTotal({ periodType: "QUARTER", periodKey: quarterKey, userId: userId || "", segmentId: segmentDoc._id }),
      aggregateSegmentTargetTotal({ periodType: "YEAR", periodKey: yearKey, userId: userId || "", segmentId: segmentDoc._id }),
      Promise.all(
        quarterMonthKeys.map((key) =>
          aggregateSegmentTargetTotal({ periodType: "MONTH", periodKey: key, userId: userId || "", segmentId: segmentDoc._id })
        )
      ).then((list) => list.reduce((acc, value) => acc + Number(value || 0), 0)),
      Promise.all(
        yearQuarterKeys.map((key) =>
          aggregateSegmentTargetTotal({ periodType: "QUARTER", periodKey: key, userId: userId || "", segmentId: segmentDoc._id })
        )
      ).then((list) => list.reduce((acc, value) => acc + Number(value || 0), 0)),
      Promise.all(
        yearMonthKeys.map((key) =>
          aggregateSegmentTargetTotal({ periodType: "MONTH", periodKey: key, userId: userId || "", segmentId: segmentDoc._id })
        )
      ).then((list) => list.reduce((acc, value) => acc + Number(value || 0), 0)),
    ]);

    const quarterTargetTotal = quarterTargetDirect || quarterTargetFallback;
    const yearTargetTotal = yearTargetDirect || yearTargetFallbackFromQuarters || yearTargetFallbackFromMonths;

    const customerMap = new Map();
    const addCustomers = (list) => {
      for (const item of Array.isArray(list) ? list : []) {
        const key = normalizeKey(item?.key || item?.customerName);
        if (!key) continue;
        if (!customerMap.has(key)) {
          customerMap.set(key, {
            key,
            customerName: String(item.customerName || "").trim(),
            area: String(item.area || "").trim(),
            monthActual: 0,
            quarterActual: 0,
            yearActual: 0,
          });
        }
      }
    };

    addCustomers(monthActualRows);
    addCustomers(quarterActualRows);
    addCustomers(yearActualRows);

    for (const item of monthActualRows) {
      const key = normalizeKey(item.key || item.customerName);
      if (!key || !customerMap.has(key)) continue;
      customerMap.get(key).monthActual = Number(item.salesInvoiced || 0);
    }
    for (const item of quarterActualRows) {
      const key = normalizeKey(item.key || item.customerName);
      if (!key || !customerMap.has(key)) continue;
      customerMap.get(key).quarterActual = Number(item.salesInvoiced || 0);
    }
    for (const item of yearActualRows) {
      const key = normalizeKey(item.key || item.customerName);
      if (!key || !customerMap.has(key)) continue;
      customerMap.get(key).yearActual = Number(item.salesInvoiced || 0);
    }

    const customers = Array.from(customerMap.values()).sort((a, b) =>
      a.customerName.localeCompare(b.customerName)
    );

    const monthActualValues = customers.map((x) => x.monthActual);
    const quarterActualValues = customers.map((x) => x.quarterActual);
    const yearActualValues = customers.map((x) => x.yearActual);

    const monthTargets = allocateTargetsByShare(monthActualValues, monthTargetTotal);
    const quarterTargets = allocateTargetsByShare(quarterActualValues, quarterTargetTotal);
    const yearTargets = allocateTargetsByShare(yearActualValues, yearTargetTotal);

    const rows = customers.map((item, index) => {
      const monthTarget = Number(monthTargets[index] || 0);
      const quarterTarget = Number(quarterTargets[index] || 0);
      const yearTarget = Number(yearTargets[index] || 0);

      const monthVariance = Math.max(monthTarget - item.monthActual, 0);
      const quarterVariance = Math.max(quarterTarget - item.quarterActual, 0);
      const yearVariance = Math.max(yearTarget - item.yearActual, 0);

      return {
        key: item.key,
        customerName: item.customerName,
        area: item.area,
        currentMonth: item.monthActual,
        actualQuarter: item.quarterActual,
        actualYear: item.yearActual,
        monthlyTarget: monthTarget,
        quarterlyTarget: quarterTarget,
        annualTarget: yearTarget,
        monthlyVariance: monthVariance,
        quarterlyVariance: quarterVariance,
        annualVariance: yearVariance,
        monthlyVariancePct: monthTarget ? Math.round((monthVariance / monthTarget) * 100) : 0,
        quarterlyVariancePct: quarterTarget ? Math.round((quarterVariance / quarterTarget) * 100) : 0,
        annualVariancePct: yearTarget ? Math.round((yearVariance / yearTarget) * 100) : 0,
      };
    });

    const summary = rows.reduce(
      (acc, row) => {
        acc.currentMonth += Number(row.currentMonth || 0);
        acc.actualQuarter += Number(row.actualQuarter || 0);
        acc.actualYear += Number(row.actualYear || 0);
        acc.monthlyTarget += Number(row.monthlyTarget || 0);
        acc.quarterlyTarget += Number(row.quarterlyTarget || 0);
        acc.annualTarget += Number(row.annualTarget || 0);
        acc.monthlyVariance += Number(row.monthlyVariance || 0);
        acc.quarterlyVariance += Number(row.quarterlyVariance || 0);
        acc.annualVariance += Number(row.annualVariance || 0);
        return acc;
      },
      {
        currentMonth: 0,
        actualQuarter: 0,
        actualYear: 0,
        monthlyTarget: 0,
        quarterlyTarget: 0,
        annualTarget: 0,
        monthlyVariance: 0,
        quarterlyVariance: 0,
        annualVariance: 0,
      }
    );

    res.json({
      monthKey,
      quarterKey,
      yearKey,
      userId: userId || "",
      segmentId: String(segmentDoc._id),
      segmentName,
      from: monthFrom,
      to: monthTo,
      rows,
      summary: {
        ...summary,
        monthlyVariancePct: summary.monthlyTarget ? Math.round((summary.monthlyVariance / summary.monthlyTarget) * 100) : 0,
        quarterlyVariancePct: summary.quarterlyTarget ? Math.round((summary.quarterlyVariance / summary.quarterlyTarget) * 100) : 0,
        annualVariancePct: summary.annualTarget ? Math.round((summary.annualVariance / summary.annualTarget) * 100) : 0,
        monthTargetTotal,
        quarterTargetTotal,
        yearTargetTotal,
        monthActualTotal: summary.currentMonth,
        quarterActualTotal: summary.actualQuarter,
        yearActualTotal: summary.actualYear,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to generate customer wise segment report" });
  }
};

async function aggregateSegmentTargets({ periodType, periodKey, userId }) {
  const q = {
    periodType,
    periodKey,
  };

  if (userId) {
    q.userId = new mongoose.Types.ObjectId(userId);
  }

  const docs = await Target.find(q).populate("segmentId", "name").lean();
  const map = new Map();

  for (const doc of docs) {
    const key = normalizeKey(doc?.segmentId?.name);
    if (!key) continue;
    map.set(key, Number(map.get(key) || 0) + Number(doc?.salesTarget || 0));
  }

  return map;
}

async function aggregateSegmentTargetsForKeys({ periodType, periodKeys, userId }) {
  const keys = Array.isArray(periodKeys) ? periodKeys.filter(Boolean) : [];
  if (!keys.length) return new Map();

  const q = {
    periodType,
    periodKey: { $in: keys },
  };

  if (userId) {
    q.userId = new mongoose.Types.ObjectId(userId);
  }

  const docs = await Target.find(q).populate("segmentId", "name").lean();
  const map = new Map();

  for (const doc of docs) {
    const key = normalizeKey(doc?.segmentId?.name);
    if (!key) continue;
    map.set(key, Number(map.get(key) || 0) + Number(doc?.salesTarget || 0));
  }

  return map;
}

function resolveTargetMap(primaryMap, fallbackMaps = []) {
  const result = new Map();
  const keys = new Set();

  for (const map of [primaryMap, ...fallbackMaps]) {
    if (!map) continue;
    for (const key of map.keys()) keys.add(key);
  }

  for (const key of keys) {
    if (primaryMap?.has(key)) {
      result.set(key, Number(primaryMap.get(key) || 0));
      continue;
    }
    let picked = false;
    for (const map of fallbackMaps) {
      if (map?.has(key)) {
        result.set(key, Number(map.get(key) || 0));
        picked = true;
        break;
      }
    }
    if (!picked) result.set(key, 0);
  }

  return result;
}

exports.adminSegmentWiseSalesReport = async (req, res) => {
  try {
    const monthKey = String(req.query.monthKey || req.query.periodKey || "").trim();
    const userId = String(req.query.userId || "").trim();

    if (!monthKey) {
      return res.status(400).json({ message: "monthKey required" });
    }

    const { from: monthFrom, to: monthTo } = getRange("MONTH", monthKey);
    const quarterKey = monthKeyToQuarterKey(monthKey);
    const yearKey = monthKeyToYearKey(monthKey);
    const { from: quarterFrom, to: quarterTo } = getRange("QUARTER", quarterKey);
    const { from: yearFrom, to: yearTo } = getRange("YEAR", yearKey);

    if (userId && !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const quarterMonthKeys = monthKeysInRange(quarterFrom, quarterTo);
    const yearMonthKeys = monthKeysInRange(yearFrom, yearTo);
    const yearQuarterKeys = quarterKeysForYear(yearKey);

    const [
      segmentDocs,
      monthActual,
      quarterActual,
      yearActual,
      monthTarget,
      quarterTarget,
      yearTarget,
      quarterTargetFallback,
      yearTargetFallbackFromQuarters,
      yearTargetFallbackFromMonths,
    ] =
      await Promise.all([
        Segment.find().sort({ name: 1 }).lean(),
        aggregateSegmentActuals({ from: monthFrom, to: monthTo, userId: userId || "" }),
        aggregateSegmentActuals({ from: quarterFrom, to: quarterTo, userId: userId || "" }),
        aggregateSegmentActuals({ from: yearFrom, to: yearTo, userId: userId || "" }),
        aggregateSegmentTargets({ periodType: "MONTH", periodKey: monthKey, userId: userId || "" }),
        aggregateSegmentTargets({ periodType: "QUARTER", periodKey: quarterKey, userId: userId || "" }),
        aggregateSegmentTargets({ periodType: "YEAR", periodKey: yearKey, userId: userId || "" }),
        aggregateSegmentTargetsForKeys({ periodType: "MONTH", periodKeys: quarterMonthKeys, userId: userId || "" }),
        aggregateSegmentTargetsForKeys({ periodType: "QUARTER", periodKeys: yearQuarterKeys, userId: userId || "" }),
        aggregateSegmentTargetsForKeys({ periodType: "MONTH", periodKeys: yearMonthKeys, userId: userId || "" }),
      ]);

    const quarterTargetResolved = resolveTargetMap(quarterTarget, [quarterTargetFallback]);
    const yearTargetResolved = resolveTargetMap(yearTarget, [yearTargetFallbackFromQuarters, yearTargetFallbackFromMonths]);

    const segmentColumns = buildSegmentColumns(
      segmentDocs,
      monthActual,
      quarterActual,
      yearActual,
      monthTarget,
      quarterTarget,
      yearTarget
    );

    const makeRow = (label, kind, sourceMap) => {
      const values = {};
      let total = 0;

      for (const segment of segmentColumns) {
        const value = Number(sourceMap.get(segment.key) || 0);
        values[segment.key] = value;
        total += value;
      }

      return { label, kind, values, total };
    };

    const actualMonthRow = makeRow("Actual Sales upto Date", "actual", monthActual);
    const actualQuarterRow = makeRow("Actual Sales upto Quarter", "actual", quarterActual);
    const actualYearRow = makeRow("Actual Annual Sales", "actual", yearActual);
    const monthTargetRow = makeRow("Monthly Target", "target", monthTarget);
    const quarterTargetRow = makeRow("Quarterly Target", "target", quarterTargetResolved);
    const yearTargetRow = makeRow("Annual Target", "target", yearTargetResolved);

    const monthlyVarianceRow = {
      label: "Monthly Target Variance",
      kind: "variance",
      values: {},
      total: 0,
    };
    const quarterlyVarianceRow = {
      label: "Quarterly Target Variance",
      kind: "variance",
      values: {},
      total: 0,
    };
    const annualVarianceRow = {
      label: "Annual Target Variance",
      kind: "variance",
      values: {},
      total: 0,
    };

    const monthlyVariancePctRow = {
      label: "Monthly Target Variance %",
      kind: "percent",
      values: {},
      total: 0,
    };
    const quarterlyVariancePctRow = {
      label: "Quarterly Target Variance %",
      kind: "percent",
      values: {},
      total: 0,
    };
    const annualVariancePctRow = {
      label: "Annual Target Variance %",
      kind: "percent",
      values: {},
      total: 0,
    };

    const fillVarianceRows = (targetRow, actualRow, varianceRow, variancePctRow) => {
      for (const segment of segmentColumns) {
        const targetValue = Number(targetRow.values[segment.key] || 0);
        const actualValue = Number(actualRow.values[segment.key] || 0);
        const cell = buildVarianceCell(targetValue, actualValue);
        varianceRow.values[segment.key] = cell;
        varianceRow.total += cell.amount;

        variancePctRow.values[segment.key] = {
          status: cell.status,
          percent: cell.percent,
          target: targetValue,
          actual: actualValue,
        };
        variancePctRow.total += cell.percent;
      }
    };

    fillVarianceRows(monthTargetRow, actualMonthRow, monthlyVarianceRow, monthlyVariancePctRow);
    fillVarianceRows(quarterTargetRow, actualQuarterRow, quarterlyVarianceRow, quarterlyVariancePctRow);
    fillVarianceRows(yearTargetRow, actualYearRow, annualVarianceRow, annualVariancePctRow);

    const summary = {
      actualMonthTotal: actualMonthRow.total,
      actualQuarterTotal: actualQuarterRow.total,
      actualYearTotal: actualYearRow.total,
      monthTargetTotal: monthTargetRow.total,
      quarterTargetTotal: quarterTargetRow.total,
      yearTargetTotal: yearTargetRow.total,
    };

    summary.monthVarianceTotal = Math.max(summary.monthTargetTotal - summary.actualMonthTotal, 0);
    summary.quarterVarianceTotal = Math.max(summary.quarterTargetTotal - summary.actualQuarterTotal, 0);
    summary.yearVarianceTotal = Math.max(summary.yearTargetTotal - summary.actualYearTotal, 0);

    summary.monthVariancePct = summary.monthTargetTotal
      ? Math.round((summary.actualMonthTotal / summary.monthTargetTotal) * 100)
      : 0;
    summary.quarterVariancePct = summary.quarterTargetTotal
      ? Math.round((summary.actualQuarterTotal / summary.quarterTargetTotal) * 100)
      : 0;
    summary.yearVariancePct = summary.yearTargetTotal
      ? Math.round((summary.actualYearTotal / summary.yearTargetTotal) * 100)
      : 0;

    res.json({
      monthKey,
      quarterKey,
      yearKey,
      userId: userId || "",
      from: monthFrom,
      to: monthTo,
      segments: segmentColumns,
      rows: [
        actualMonthRow,
        actualQuarterRow,
        actualYearRow,
        monthTargetRow,
        quarterTargetRow,
        yearTargetRow,
        monthlyVarianceRow,
        quarterlyVarianceRow,
        annualVarianceRow,
        monthlyVariancePctRow,
        quarterlyVariancePctRow,
        annualVariancePctRow,
      ],
      summary,
    });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to generate segment wise report" });
  }
};

exports.adminPerformanceReport = async (req, res) => {
  try {
    const { periodType = "MONTH", periodKey, segmentId = "" } = req.query;
    if (!periodKey) return res.status(400).json({ message: "periodKey required" });

    const { from, to } = getRange(periodType, periodKey);
    const selectedSegment = String(segmentId || "").trim();
    let segmentDoc = null;
    if (selectedSegment) {
      if (!mongoose.Types.ObjectId.isValid(selectedSegment)) {
        return res.status(400).json({ message: "Invalid segmentId" });
      }
      segmentDoc = await Segment.findById(selectedSegment).lean();
      if (!segmentDoc) return res.status(404).json({ message: "Segment not found" });
    }

    const segmentName = String(segmentDoc?.name || "").trim();
    const rowsExpr = segmentName
      ? {
          $filter: {
            input: { $ifNull: ["$rows", []] },
            as: "r",
            cond: { $eq: ["$$r.segment", segmentName] },
          },
        }
      : { $ifNull: ["$rows", []] };

    // 1) aggregate actuals from daily reports
    const actualAgg = await DailyCustomerReport.aggregate([
      { $match: { reportDateKey: { $gte: from, $lte: to } } },
      {
        $project: {
          userId: 1,
          km: { $subtract: ["$closingKm", "$openingKm"] },
          rows: rowsExpr
        }
      },
      {
        $addFields: {
          vendorsVisited: { $size: { $ifNull: ["$rows", []] } },
          newVendorsAdded: {
            $size: {
              $filter: {
                input: { $ifNull: ["$rows", []] },
                as: "r",
                cond: { $eq: ["$$r.newOrExisting", "New"] }
              }
            }
          },
          orderGenerated: {
            $sum: {
              $map: { input: { $ifNull: ["$rows", []] }, as: "r", in: { $ifNull: ["$$r.orderGenerated", 0] } }
            }
          },
          salesInvoiced: {
            $sum: {
              $map: { input: { $ifNull: ["$rows", []] }, as: "r", in: { $ifNull: ["$$r.salesInvoiced", 0] } }
            }
          },
          collection: {
            $sum: {
              $map: { input: { $ifNull: ["$rows", []] }, as: "r", in: { $ifNull: ["$$r.poReceived", 0] } }
            }
          }
        }
      },
      {
        $group: {
          _id: "$userId",
          runningKm: { $sum: "$km" },
          vendorsVisited: { $sum: "$vendorsVisited" },
          newVendorsAdded: { $sum: "$newVendorsAdded" },
          orderGenerated: { $sum: "$orderGenerated" },
          salesInvoiced: { $sum: "$salesInvoiced" },
          collection: { $sum: "$collection" },
        }
      }
    ]);

    // 2) load rolled-up targets for same period and aggregate by user
    const userIds = actualAgg.map((x) => x._id);
    const targets = await resolveTargetRows({ periodType, periodKey });
    const filteredTargets = selectedSegment
      ? targets.filter((t) => String(t?.segmentId?.name || "").trim().toLowerCase() === segmentName.toLowerCase())
      : targets;

    // Aggregate targets by userId
    const targetMap = new Map();
    for (const t of filteredTargets) {
      const uid = String(t?.userId?._id || t?.userId || "");
      if (!uid) continue;
      const existing = targetMap.get(uid) || {
        vendorVisitTarget: 0,
        newVendorTarget: 0,
        salesTarget: 0,
        collectionTarget: 0,
      };
      existing.vendorVisitTarget += Number(t.vendorVisitTarget || 0);
      existing.newVendorTarget += Number(t.newVendorTarget || 0);
      existing.salesTarget += Number(t.salesTarget || 0);
      existing.collectionTarget += Number(t.collectionTarget || 0);
      targetMap.set(uid, existing);
    }

    // 3) attach names
    const users = await User.find({ _id: { $in: userIds } }).select("name email").lean();
    const userMap = new Map(users.map(u => [String(u._id), u]));

    // 4) merge + compute pending%
    const items = actualAgg.map(a => {
      const t = targetMap.get(String(a._id)) || {};
      const u = userMap.get(String(a._id)) || {};
      const safePct = (pending, target) => target > 0 ? Math.round((pending / target) * 100) : 0;

      const pendingVisits = (t.vendorVisitTarget || 0) - a.vendorsVisited;
      const pendingNew = (t.newVendorTarget || 0) - a.newVendorsAdded;
      const salesActual = a.salesInvoiced || a.sales || 0;
      const pendingSales = (t.salesTarget || 0) - salesActual;
      const pendingColl = (t.collectionTarget || 0) - a.collection;

      return {
        userId: a._id,
        name: u.name || "-",
        email: u.email || "-",
        actual: a,
        target: {
          vendorVisitTarget: t.vendorVisitTarget || 0,
          newVendorTarget: t.newVendorTarget || 0,
          salesTarget: t.salesTarget || 0,
          collectionTarget: t.collectionTarget || 0,
        },
        pending: {
          vendorVisitPending: pendingVisits,
          newVendorPending: pendingNew,
          salesPending: pendingSales,
          collectionPending: pendingColl,
        },
        pendingPct: {
          vendorVisitPendingPct: safePct(pendingVisits, t.vendorVisitTarget || 0),
          newVendorPendingPct: safePct(pendingNew, t.newVendorTarget || 0),
          salesPendingPct: safePct(pendingSales, t.salesTarget || 0),
          collectionPendingPct: safePct(pendingColl, t.collectionTarget || 0),
        },
        salesInvoiced: salesActual,
        sales: salesActual,
      };
    });

    res.json({
      periodType,
      periodKey,
      from,
      to,
      segmentId: selectedSegment,
      segmentName: segmentName || "",
      items,
    });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to generate report" });
  }
};

exports.adminCustomerWiseReport = async (req, res) => {
  try {
    const { userId, periodType = "MONTH", periodKey, segment } = req.query;

    if (!userId) return res.status(400).json({ message: "userId required" });
    if (!periodKey) return res.status(400).json({ message: "periodKey required" });

    const { from, to } = getRange(periodType, periodKey);
    const customerLookup = await buildCustomerLookup();

    const match = {
      userId: new mongoose.Types.ObjectId(userId),
      reportDateKey: { $gte: from, $lte: to },
    };

    const periodDocs = await DailyCustomerReport.find(match).select("_id rows").lean();

    const rowContextMap = new Map();
    const customerMap = new Map();
    const rowContexts = [];

    const getCustomerKey = (customerName, area) =>
      `${normalizeKey(customerName)}|${normalizeKey(area)}`;

    for (const doc of periodDocs) {
      const rows = Array.isArray(doc?.rows) ? doc.rows : [];
      for (const row of rows) {
        const normalizedRow = enrichCustomerRow(row, customerLookup);
        if (!normalizedRow.customerName) continue;
        if (segment && normalizeKey(normalizedRow.segment) !== normalizeKey(segment)) continue;

        const rowId = String(normalizedRow._id || normalizedRow.rowId || row?._id || "").trim();
        if (rowId) {
          rowContextMap.set(`${String(doc._id)}|${rowId}`, normalizedRow);
        }

        const key = getCustomerKey(normalizedRow.customerName, normalizedRow.area);
        if (!customerMap.has(key)) {
          customerMap.set(key, {
            key: normalizeKey(normalizedRow.customerName),
            customerName: normalizedRow.customerName,
            area: normalizedRow.area,
            segment: normalizedRow.segment,
            orderGenerated: 0,
            salesInvoiced: 0,
            collection: 0,
            visits: 0,
          });
        }

        const financeRowKey = `${String(doc._id)}|${rowId}`;
        const item = customerMap.get(key);
        item.area = item.area || normalizedRow.area;
        item.segment = item.segment || normalizedRow.segment;
        item.orderGenerated += Number(normalizedRow.orderGenerated || 0);
        item.visits += 1;

        rowContexts.push({
          customerKey: key,
          reportKey: financeRowKey,
          fallbackSalesInvoiced: Number(normalizedRow.salesInvoiced || normalizedRow.sales || 0),
          fallbackCollection: Number(normalizedRow.poReceived || 0),
        });
      }
    }

    const financeMatch = {
      userId: new mongoose.Types.ObjectId(userId),
      entryDate: { $gte: from, $lte: to },
    };
    const financeEntries = await DailyReportFinanceEntry.find(financeMatch)
      .select("dailyReportId rowId type amount")
      .lean();

    const periodReportIds = new Set(periodDocs.map((doc) => String(doc?._id || "")));
    const financeReportIds = Array.from(
      new Set(financeEntries.map((entry) => String(entry?.dailyReportId || "")).filter(Boolean))
    );
    const extraReportIds = financeReportIds.filter((id) => !periodReportIds.has(id));
    if (extraReportIds.length) {
      const extraDocs = await DailyCustomerReport.find({
        _id: { $in: extraReportIds },
      })
        .select("_id rows")
        .lean();

      for (const doc of extraDocs) {
        const rows = Array.isArray(doc?.rows) ? doc.rows : [];
        for (const row of rows) {
          const normalizedRow = enrichCustomerRow(row, customerLookup);
          if (!normalizedRow.customerName) continue;
          if (segment && normalizeKey(normalizedRow.segment) !== normalizeKey(segment)) continue;

          const rowId = String(normalizedRow._id || normalizedRow.rowId || row?._id || "").trim();
          if (rowId) {
            rowContextMap.set(`${String(doc._id)}|${rowId}`, normalizedRow);
          }
        }
      }
    }

    const financeByRow = new Map();
    for (const entry of financeEntries) {
      const financeRowKey = `${String(entry?.dailyReportId || "")}|${String(entry?.rowId || "")}`;
      const rowContext = rowContextMap.get(financeRowKey);
      if (!rowContext) continue;
      if (segment && normalizeKey(rowContext.segment) !== normalizeKey(segment)) continue;

      const current = financeByRow.get(financeRowKey) || { salesInvoiced: 0, collection: 0 };
      if (String(entry.type) === "INVOICE") {
        current.salesInvoiced += Number(entry.amount || 0);
      } else if (String(entry.type) === "COLLECTION") {
        current.collection += Number(entry.amount || 0);
      }
      financeByRow.set(financeRowKey, current);
    }

    for (const ctx of rowContexts) {
      const item = customerMap.get(ctx.customerKey);
      if (!item) continue;
      const finance = financeByRow.get(ctx.reportKey);
      if (!finance) {
        const salesInvoiced = Number(ctx.fallbackSalesInvoiced || 0);
        const collection = Number(ctx.fallbackCollection || 0);
        item.salesInvoiced += salesInvoiced;
        item.sales += salesInvoiced;
        item.collection += collection;
      }
    }

    for (const entry of financeEntries) {
      const financeRowKey = `${String(entry?.dailyReportId || "")}|${String(entry?.rowId || "")}`;
      const rowContext = rowContextMap.get(financeRowKey);
      if (!rowContext) continue;
      if (segment && normalizeKey(rowContext.segment) !== normalizeKey(segment)) continue;

      const key = getCustomerKey(rowContext.customerName, rowContext.area);
      if (!customerMap.has(key)) {
        customerMap.set(key, {
          key: normalizeKey(rowContext.customerName),
          customerName: rowContext.customerName,
          area: rowContext.area,
          segment: rowContext.segment,
          orderGenerated: 0,
          salesInvoiced: 0,
          collection: 0,
          visits: 0,
        });
      }

      const item = customerMap.get(key);
      const amount = Number(entry.amount || 0);
      if (String(entry.type) === "INVOICE") {
        item.salesInvoiced += amount;
        item.sales += amount;
      } else if (String(entry.type) === "COLLECTION") {
        item.collection += amount;
      }
    }

    const list = Array.from(customerMap.values())
      .sort((a, b) => {
        if (b.salesInvoiced !== a.salesInvoiced) return b.salesInvoiced - a.salesInvoiced;
        return String(a.customerName || "").localeCompare(String(b.customerName || ""));
      })
      .map((item) => ({
        _id: item.key,
        area: item.area,
        segment: item.segment,
        orderGenerated: item.orderGenerated,
        salesInvoiced: item.salesInvoiced,
        sales: item.sales,
        collection: item.collection,
        visits: item.visits,
        customerName: item.customerName,
      }));

    return res.json({ periodType, periodKey, from, to, items: list });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed" });
  }
};

exports.adminLeadConversionReport = async (req, res) => {
  try {
    const { periodType = "MONTH", periodKey } = req.query;
    if (!periodKey) return res.status(400).json({ message: "periodKey required" });

    const { from, to } = getRange(periodType, periodKey);

    const docs = await DailyCustomerReport.find({
      reportDateKey: { $gte: from, $lte: to },
    })
      .select("userId openingKm closingKm rows reportDateKey")
      .sort({ reportDateKey: 1, updatedAt: 1 })
      .lean();

    const byUser = new Map();

    for (const d of docs) {
      const uid = String(d.userId);
      if (!byUser.has(uid)) {
        byUser.set(uid, {
          userId: uid,
          runningKm: 0,
          enquiryReceived: 0,
          enquiryConverted: 0,
          salesInvoiced: 0,
          modeCounts: {},
          customers: new Map(),
        });
      }

      const agg = byUser.get(uid);
      const opening = Number(d.openingKm || 0);
      const closing = Number(d.closingKm || 0);
      agg.runningKm += Math.max(closing - opening, 0);

      const rows = Array.isArray(d.rows) ? d.rows : [];
      for (const r of rows) {
        const customerName = String(r?.customerName || "").trim();
        if (!customerName) continue;
        const customerKey = normalizeKey(customerName);
        const order = Number(r?.orderGenerated || 0);
        const sales = Number(r?.salesInvoiced || 0);
        const collection = Number(r?.poReceived || 0);
        const mode = String(r?.enquiryMode || "").trim();
        agg.salesInvoiced += sales;

        if (!agg.customers.has(customerKey)) {
          agg.customers.set(customerKey, {
            customerName,
            converted: false,
            mode: "",
            modeCaptured: false,
          });
        }

        const customer = agg.customers.get(customerKey);
        if (!customer.modeCaptured && mode) {
          customer.mode = mode;
          customer.modeCaptured = true;
          agg.modeCounts[mode] = (agg.modeCounts[mode] || 0) + 1;
        }

        if (order > 0 || sales > 0 || collection > 0) {
          customer.converted = true;
        }
      }
    }

    const userIds = Array.from(byUser.keys()).map((id) => new mongoose.Types.ObjectId(id));
    const users = await User.find({ _id: { $in: userIds } }).select("name email").lean();
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const pickTopMode = (modeCounts) => {
      const entries = Object.entries(modeCounts || {});
      if (!entries.length) return "-";
      entries.sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });
      return entries[0][0];
    };

    const items = Array.from(byUser.values())
      .map((x) => {
        const u = userMap.get(x.userId) || {};
        const customers = Array.from(x.customers.values());
        const enquiryReceived = customers.length;
        const enquiryConverted = customers.filter((c) => c.converted).length;

        return {
          userId: x.userId,
          name: u.name || "-",
          email: u.email || "-",
          runningKm: x.runningKm,
          enquiryReceived,
          modeOfEnquiry: pickTopMode(x.modeCounts),
          enquiryConverted,
          salesInvoiced: x.salesInvoiced,
          sales: x.salesInvoiced,
          conversionRatio: enquiryReceived ? Math.round((enquiryConverted / enquiryReceived) * 100) : 0,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const totals = items.reduce(
      (acc, x) => {
        acc.runningKm += Number(x.runningKm || 0);
        acc.enquiryReceived += Number(x.enquiryReceived || 0);
        acc.enquiryConverted += Number(x.enquiryConverted || 0);
        acc.salesInvoiced += Number(x.salesInvoiced || x.sales || 0);
        return acc;
      },
      { runningKm: 0, enquiryReceived: 0, enquiryConverted: 0, salesInvoiced: 0 }
    );

    const consolidatedConversionRatio = totals.enquiryReceived
      ? Math.round((totals.enquiryConverted / totals.enquiryReceived) * 100)
      : 0;

    const averageSalesPerVendor = totals.enquiryConverted
      ? Math.round(totals.salesInvoiced / totals.enquiryConverted)
      : 0;

    return res.json({
      periodType,
      periodKey,
      from,
      to,
      items,
      summary: {
        ...totals,
        sales: totals.salesInvoiced,
        consolidatedConversionRatio,
        averageSalesPerVendor,
      },
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to generate lead conversion report" });
  }
};

exports.myCustomerCollectionTracker = async (req, res) => {
  try {
    const { periodType = "MONTH", periodKey } = req.query;
    if (!periodKey) return res.status(400).json({ message: "periodKey required" });

    const { from, to } = getRange(periodType, periodKey);
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const items = await DailyCustomerReport.aggregate([
      {
        $match: {
          userId,
          reportDateKey: { $gte: from, $lte: to }
        }
      },
      { $unwind: "$rows" },
      {
        $project: {
          customerName: { $trim: { input: { $ifNull: ["$rows.customerName", ""] } } },
          area: { $trim: { input: { $ifNull: ["$rows.area", ""] } } },
          orderGenerated: { $ifNull: ["$rows.orderGenerated", 0] },
          salesInvoiced: { $ifNull: ["$rows.salesInvoiced", 0] },
          collection: { $ifNull: ["$rows.poReceived", 0] }
        }
      },
      { $match: { customerName: { $ne: "" } } },
      {
        $group: {
          _id: { customerName: "$customerName", area: "$area" },
          customerName: { $first: "$customerName" },
          area: { $first: "$area" },
          visits: { $sum: 1 },
          orderGenerated: { $sum: "$orderGenerated" },
          salesInvoiced: { $sum: "$salesInvoiced" },
          collection: { $sum: "$collection" }
        }
      },
      {
        $addFields: {
          pendingCollection: {
            $cond: [
              { $gt: [{ $subtract: ["$salesInvoiced", "$collection"] }, 0] },
              { $subtract: ["$salesInvoiced", "$collection"] },
              0
            ]
          }
        }
      },
      { $sort: { pendingCollection: -1, salesInvoiced: -1, customerName: 1 } },
      {
        $project: {
          _id: 0,
          customerName: 1,
          area: 1,
          visits: 1,
          orderGenerated: 1,
          salesInvoiced: 1,
          sales: "$salesInvoiced",
          collection: 1,
          pendingCollection: 1
        }
      }
    ]);

    const summary = items.reduce(
      (acc, x) => {
        acc.orderGenerated += Number(x.orderGenerated || 0);
        acc.salesInvoiced += Number(x.salesInvoiced || 0);
        acc.sales += Number(x.salesInvoiced || 0);
        acc.collection += Number(x.collection || 0);
        acc.pendingCollection += Number(x.pendingCollection || 0);
        acc.clients += 1;
        return acc;
      },
      { orderGenerated: 0, salesInvoiced: 0, sales: 0, collection: 0, pendingCollection: 0, clients: 0 }
    );

    return res.json({ periodType, periodKey, from, to, items, summary });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load customer tracker" });
  }
};
