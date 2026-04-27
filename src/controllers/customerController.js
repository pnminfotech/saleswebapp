const Customer = require("../models/Customer");
const DailyCustomerReport = require("../models/DailyCustomerReport");
const DailyReportFinanceEntry = require("../models/DailyReportFinanceEntry");
const {
  buildCustomerSearchFilter,
  buildCustomerSelectFields,
  buildCustomerLookupMap,
  normalizeCustomerKey,
  toTitleCase,
  upsertCustomerByName,
} = require("../utils/customerMaster");

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildExactNameRegex(value) {
  const normalized = toTitleCase(value);
  if (!normalized) return null;
  return new RegExp(`^${escapeRegex(normalized).replace(/\s+/g, "\\s+")}$`, "i");
}

function formatCustomerForResponse(doc) {
  if (!doc) return doc;
  const base = doc?.toObject ? doc.toObject() : doc;
  return {
    ...base,
    name: toTitleCase(base.name),
    clientType: base.clientType || "Existing",
    area: toTitleCase(base.area),
    metTo: toTitleCase(base.metTo),
    designation: toTitleCase(base.designation),
    segment: toTitleCase(base.segment),
  };
}

async function syncCustomerAcrossSystem(customerDoc, previousName = "") {
  if (!customerDoc?._id) return;

  const customerId = String(customerDoc._id).trim();
  const currentName = toTitleCase(customerDoc.name);
  const previousKey = normalizeCustomerKey(previousName);
  const currentKey = normalizeCustomerKey(currentName);
  const customerLookup = buildCustomerLookupMap([customerDoc.toObject ? customerDoc.toObject() : customerDoc]);
  const query = [{ "rows.customerId": customerDoc._id }];
  const previousRegex = buildExactNameRegex(previousName);
  const currentRegex = buildExactNameRegex(currentName);
  if (previousRegex) query.push({ "rows.customerName": previousRegex });
  if (currentRegex) query.push({ "rows.customerName": currentRegex });

  const reports = await DailyCustomerReport.find({ $or: query }).select("_id rows").lean();

  for (const report of Array.isArray(reports) ? reports : []) {
    let changed = false;
    const changedRowIds = [];
    const rows = Array.isArray(report.rows) ? report.rows : [];
    const nextRows = rows.map((row) => {
      const rowCustomerId = String(row?.customerId || "").trim();
      const rowNameKey = normalizeCustomerKey(row?.customerName);
      const matches = rowCustomerId === customerId || rowNameKey === previousKey || rowNameKey === currentKey;
      if (!matches) return row;
      changed = true;
      const rowId = String(row?._id || row?.rowId || "").trim();
      if (rowId) changedRowIds.push(rowId);
      const found = customerLookup.get(`id:${customerId}`) || {};
      const next = {
        ...row,
        customerId: customerDoc._id,
        customerName: currentName,
        clientType: customerDoc.clientType || found.clientType || row.clientType || "Existing",
        area: toTitleCase(customerDoc.area || found.area || row.area),
        metTo: toTitleCase(customerDoc.metTo || found.metTo || row.metTo),
        designation: toTitleCase(customerDoc.designation || found.designation || row.designation),
        segment: toTitleCase(customerDoc.segment || found.segment || row.segment),
      };
      return next;
    });

    if (!changed) continue;

    await DailyCustomerReport.updateOne({ _id: report._id }, { $set: { rows: nextRows } });

    if (changedRowIds.length) {
      await DailyReportFinanceEntry.updateMany(
        {
          dailyReportId: report._id,
          rowId: { $in: changedRowIds },
        },
        {
          $set: {
            customerName: currentName,
          },
        }
      );
    }
  }
}

exports.searchCustomers = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 20), 50);

    const filter = buildCustomerSearchFilter(q);

    const list = await Customer.find(filter)
      .sort({ name: 1 })
      .limit(limit)
      .select(buildCustomerSelectFields());

    res.json(list.map(formatCustomerForResponse));
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to search customers" });
  }
};

exports.listCustomers = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 100), 200);

    const filter = buildCustomerSearchFilter(q);

    const list = await Customer.find(filter)
      .sort({ name: 1 })
      .limit(limit)
      .select(buildCustomerSelectFields());

    res.json(list.map(formatCustomerForResponse));
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load customers" });
  }
};

// Upsert by customer name so admin can refresh contact details without duplicates.
exports.createCustomer = async (req, res) => {
  try {
    const doc = await upsertCustomerByName(Customer, req.body, { createdBy: req.user?.id });

    await syncCustomerAcrossSystem(doc);
    res.json(formatCustomerForResponse(doc?.toObject ? doc.toObject() : doc));
  } catch (e) {
    const statusCode = Number(e?.statusCode || 0);
    res.status(statusCode >= 400 ? statusCode : 500).json({ message: e.message || "Failed to save customer" });
  }
};

exports.updateCustomer = async (req, res) => {
  try {
    const existing = await Customer.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: "Client not found" });
    }

    const previousName = existing.name;
    const nextName = toTitleCase(req.body.name || existing.name);
    if (!nextName) {
      return res.status(400).json({ message: "Client name is required" });
    }

    const duplicate = await Customer.findOne({
      _id: { $ne: existing._id },
      name: { $regex: `^${nextName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });
    if (duplicate) {
      return res.status(409).json({ message: "Client name already exists" });
    }

    existing.name = nextName;
    existing.clientType = req.body.clientType || existing.clientType || "Existing";
    existing.area = toTitleCase(req.body.area || existing.area);
    existing.metTo = toTitleCase(req.body.metTo || existing.metTo);
    existing.designation = toTitleCase(req.body.designation || existing.designation);
    existing.segment = toTitleCase(req.body.segment || existing.segment);
    await existing.save();

    await syncCustomerAcrossSystem(existing, previousName);
    return res.json(formatCustomerForResponse(existing.toObject()));
  } catch (e) {
    const statusCode = Number(e?.statusCode || 0);
    res.status(statusCode >= 400 ? statusCode : 500).json({ message: e.message || "Failed to update client" });
  }
};
