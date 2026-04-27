const Target = require("../models/Target");
const User = require("../models/User");
const { upsertTargetSchema } = require("../utils/validators");
const { resolveTargetRows, summarizeTargetRows } = require("../utils/targetRollup");
const { buildTargetContext, validateTargetWrite, TARGET_FIELDS } = require("../utils/targetValidation");

const CompanySettings = require("../models/CompanySettings");

function normalizeLookupKey(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesSegmentFilter(row, segmentId) {
  const filterKey = normalizeLookupKey(segmentId);
  if (!filterKey) return true;

  const rowSegmentId = normalizeLookupKey(row?.segmentId?._id || row?.segmentId);
  const rowSegmentName = normalizeLookupKey(row?.segmentId?.name);
  return rowSegmentId === filterKey || rowSegmentName === filterKey;
}

async function buildSalespersonSnapshot(userId) {
  if (!userId) return { salespersonName: "", salespersonEmail: "" };
  const user = await User.findById(userId).select("name email").lean();
  return {
    salespersonName: String(user?.name || "").trim(),
    salespersonEmail: String(user?.email || "").trim(),
  };
}

async function upsertTarget(req, res) {
  const parsed = upsertTargetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const d = parsed.data;
  const validation = await validateTargetWrite({
    userId: d.userId,
    segmentId: d.segmentId,
    periodType: d.periodType,
    periodKey: d.periodKey,
    values: d,
  });

  if (!validation.ok) {
    return res.status(400).json({
      message: validation.errors[0] || "Target values are not valid for this period",
      errors: validation.errors,
    });
  }

  const snapshot = await buildSalespersonSnapshot(d.userId);

  const doc = await Target.findOneAndUpdate(
    { userId: d.userId, segmentId: d.segmentId, periodType: d.periodType, periodKey: d.periodKey },
    {
      $set: {
        vendorVisitTarget: d.vendorVisitTarget ?? 0,
        newVendorTarget: d.newVendorTarget ?? 0,
        salesTarget: d.salesTarget ?? 0,
        collectionTarget: d.collectionTarget ?? 0,
        periodBasis: "FISCAL",
      },
      $setOnInsert: {
        salespersonName: snapshot.salespersonName,
        salespersonEmail: snapshot.salespersonEmail,
      }
    },
    { upsert: true, new: true }
  );

  if (!doc.salespersonName && snapshot.salespersonName) {
    doc.salespersonName = snapshot.salespersonName;
  }
  if (!doc.salespersonEmail && snapshot.salespersonEmail) {
    doc.salespersonEmail = snapshot.salespersonEmail;
  }
  await doc.save();

  res.json(doc);
}

async function getMyTarget(req, res) {
  const { periodType = "MONTH", periodKey } = req.query;
  if (!periodKey) return res.status(400).json({ message: "periodKey required" });
  const rows = await resolveTargetRows({ periodType, periodKey, userId: req.user._id });
  res.json(summarizeTargetRows(rows));
}

async function getTargetSummary(req, res) {
  try {
    const { periodType = "MONTH", periodKey, userId, segmentId } = req.query;
    if (!periodKey) return res.status(400).json({ message: "periodKey required" });

    let rows = await resolveTargetRows({ periodType, periodKey, userId });
    rows = rows.filter((row) => matchesSegmentFilter(row, segmentId));
    return res.json({
      periodType,
      periodKey,
      summary: summarizeTargetRows(rows),
      rows,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load target summary" });
  }
}

async function getTargetContext(req, res) {
  try {
    const { userId, segmentId, periodType = "MONTH", periodKey } = req.query;
    if (!userId || !segmentId || !periodKey) {
      return res.status(400).json({ message: "userId, segmentId, periodKey are required" });
    }

    const context = await buildTargetContext({
      userId,
      segmentId,
      periodType,
      periodKey,
    });

    return res.json({
      ...context,
      fields: TARGET_FIELDS,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load target context" });
  }
}

async function getOneTargetForAdmin(req, res) {
  try {
    const { userId, segmentId, periodType, periodKey } = req.query;

    if (!userId || !segmentId || !periodType || !periodKey) {
      return res.status(400).json({ message: "userId, segmentId, periodType, periodKey are required" });
    }

    const t = await Target.findOne({ userId, segmentId, periodType, periodKey });
    return res.json(t || null);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}
async function listTargetsForAdmin(req, res) {
  try {
    const { userId, segmentId, periodType, periodKey } = req.query;

    const q = {};
    if (userId) q.userId = userId;
    if (segmentId) q.segmentId = segmentId;
    if (periodType) q.periodType = periodType;
    if (periodKey) q.periodKey = periodKey;

    const items = await Target.find(q)
      .select("userId salespersonName salespersonEmail segmentId periodType periodKey vendorVisitTarget newVendorTarget salesTarget collectionTarget source parentKey createdAt updatedAt")
      .sort({ periodType: 1, periodKey: 1, createdAt: -1 })
      .populate("userId", "name email")
      .populate("segmentId", "name");

    return res.json(items);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

async function deleteTarget(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ message: "Target id required" });
    }

    const deleted = await Target.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: "Target not found" });
    }

    return res.json({ message: "Target deleted", deletedId: id });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to delete target" });
  }
}

// helper: upsert but preserve MANUAL children if overwriteAutoOnly is true
async function upsertChild({ userId, periodType, periodKey, parentKey, data, overwriteAutoOnly }) {
  const snapshot = await buildSalespersonSnapshot(userId);
  const existing = await Target.findOne({ userId, periodType, periodKey });

  if (existing) {
    if (overwriteAutoOnly && existing.source === "MANUAL") return existing; // don't touch manual overrides
    existing.vendorVisitTarget = data.vendorVisitTarget ?? 0;
    existing.newVendorTarget = data.newVendorTarget ?? 0;
    existing.salesTarget = data.salesTarget ?? 0;
    existing.collectionTarget = data.collectionTarget ?? 0;
    existing.salespersonName = existing.salespersonName || snapshot.salespersonName;
    existing.salespersonEmail = existing.salespersonEmail || snapshot.salespersonEmail;
    existing.periodBasis = "FISCAL";
    existing.source = "AUTO";
    existing.parentKey = parentKey;
    return existing.save();
  }

  return Target.create({
    userId,
    salespersonName: snapshot.salespersonName,
    salespersonEmail: snapshot.salespersonEmail,
    periodType,
    periodKey,
    periodBasis: "FISCAL",
    ...data,
    source: "AUTO",
    parentKey
  });
}

async function upsertAnnualAndGenerate(req, res) {
  try {
    const {
      userId,
      yearKey, // FY2025-26, CY2026, or plain 2026 (FY start year)
      vendorVisitTarget = 0,
      newVendorTarget = 0,
      salesTarget = 0,
      collectionTarget = 0,
      overwriteAutoOnly = true, // ✅ recommended default
    } = req.body || {};

    if (!userId || !yearKey) {
      return res.status(400).json({ message: "userId and yearKey are required" });
    }

    const snapshot = await buildSalespersonSnapshot(userId);

    // 1) upsert annual as MANUAL
    const annual = await Target.findOneAndUpdate(
      { userId, periodType: "YEAR", periodKey: yearKey },
      {
        $set: {
          vendorVisitTarget: Number(vendorVisitTarget || 0),
          newVendorTarget: Number(newVendorTarget || 0),
          salesTarget: Number(salesTarget || 0),
          collectionTarget: Number(collectionTarget || 0),
          periodBasis: "FISCAL",
          source: "MANUAL",
          parentKey: "",
          salespersonName: snapshot.salespersonName,
          salespersonEmail: snapshot.salespersonEmail,
        },
        $setOnInsert: {
          salespersonName: snapshot.salespersonName,
          salespersonEmail: snapshot.salespersonEmail,
        },
      },
      { upsert: true, new: true }
    );

    if (!annual.salespersonName && snapshot.salespersonName) annual.salespersonName = snapshot.salespersonName;
    if (!annual.salespersonEmail && snapshot.salespersonEmail) annual.salespersonEmail = snapshot.salespersonEmail;
    await annual.save();

    // 2) generate quarters + months (equal split)
    const qData = {
      vendorVisitTarget: Math.round(Number(vendorVisitTarget || 0) / 4),
      newVendorTarget: Math.round(Number(newVendorTarget || 0) / 4),
      salesTarget: Math.round(Number(salesTarget || 0) / 4),
      collectionTarget: Math.round(Number(collectionTarget || 0) / 4),
    };

    const mData = {
      vendorVisitTarget: Math.round(Number(vendorVisitTarget || 0) / 12),
      newVendorTarget: Math.round(Number(newVendorTarget || 0) / 12),
      salesTarget: Math.round(Number(salesTarget || 0) / 12),
      collectionTarget: Math.round(Number(collectionTarget || 0) / 12),
    };

    const isCalendarYear = String(yearKey || "").trim().toUpperCase().startsWith("CY");
    const yearStart = Number(String(yearKey || "").trim().replace(/^(FY|CY)/i, "").slice(0, 4));

    // Quarter keys remain the same shape, but FY/Q1 now means Apr-Jun.
    const qKeys = ["Q1", "Q2", "Q3", "Q4"].map((q) => `${yearKey}-${q}`);

    const monthKeys = isCalendarYear
      ? Array.from({ length: 12 }, (_, i) => {
          const yr = yearStart;
          return `${yr}-${String(i + 1).padStart(2, "0")}`;
        })
      : [
          ...Array.from({ length: 9 }, (_, i) => `${yearStart}-${String(i + 4).padStart(2, "0")}`),
          ...Array.from({ length: 3 }, (_, i) => `${yearStart + 1}-${String(i + 1).padStart(2, "0")}`),
        ];

    await Promise.all(
      qKeys.map((k) =>
        upsertChild({
          userId,
          periodType: "QUARTER",
          periodKey: k,
          parentKey: yearKey,
          data: qData,
          overwriteAutoOnly,
        })
      )
    );

    await Promise.all(
      monthKeys.map((k) =>
        upsertChild({
          userId,
          periodType: "MONTH",
          periodKey: k,
          parentKey: yearKey,
          data: mData,
          overwriteAutoOnly,
        })
      )
    );

    return res.json({ annual, generated: { quarters: qKeys.length, months: monthKeys.length } });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}


module.exports = {
  upsertTarget,
  getMyTarget,
  getTargetSummary,
  getTargetContext,
  getOneTargetForAdmin,
  listTargetsForAdmin,
  deleteTarget,
  upsertAnnualAndGenerate,
};
