const Target = require("../models/Target");
const { upsertTargetSchema } = require("../utils/validators");

const CompanySettings = require("../models/CompanySettings");
async function upsertTarget(req, res) {
  const parsed = upsertTargetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const d = parsed.data;

  const doc = await Target.findOneAndUpdate(
    { userId: d.userId, periodType: d.periodType, periodKey: d.periodKey },
    {
      $set: {
        vendorVisitTarget: d.vendorVisitTarget ?? 0,
        newVendorTarget: d.newVendorTarget ?? 0,
        salesTarget: d.salesTarget ?? 0,
        collectionTarget: d.collectionTarget ?? 0
      }
    },
    { upsert: true, new: true }
  );

  res.json(doc);
}

async function getMyTarget(req, res) {
  const { periodType = "MONTH", periodKey } = req.query;
  if (!periodKey) return res.status(400).json({ message: "periodKey required" });

  const t = await Target.findOne({
    userId: req.user._id,
    periodType,
    periodKey
  });

  res.json(t || null);
}
async function getOneTargetForAdmin(req, res) {
  try {
    const { userId, periodType, periodKey } = req.query;

    if (!userId || !periodType || !periodKey) {
      return res.status(400).json({ message: "userId, periodType, periodKey are required" });
    }

    const t = await Target.findOne({ userId, periodType, periodKey });
    return res.json(t || null);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}
async function listTargetsForAdmin(req, res) {
  try {
    const { userId, periodType, periodKey } = req.query;

    const q = {};
    if (userId) q.userId = userId;
    if (periodType) q.periodType = periodType;
    if (periodKey) q.periodKey = periodKey;

    const items = await Target.find(q)
      .sort({ periodType: 1, periodKey: 1, createdAt: -1 })
      .populate("userId", "name email"); // show salesperson name/email

    return res.json(items);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
}

// helper: upsert but preserve MANUAL children if overwriteAutoOnly is true
async function upsertChild({ userId, periodType, periodKey, parentKey, data, overwriteAutoOnly }) {
  const existing = await Target.findOne({ userId, periodType, periodKey });

  if (existing) {
    if (overwriteAutoOnly && existing.source === "MANUAL") return existing; // don't touch manual overrides
    existing.vendorVisitTarget = data.vendorVisitTarget ?? 0;
    existing.newVendorTarget = data.newVendorTarget ?? 0;
    existing.salesTarget = data.salesTarget ?? 0;
    existing.collectionTarget = data.collectionTarget ?? 0;
    existing.source = "AUTO";
    existing.parentKey = parentKey;
    return existing.save();
  }

  return Target.create({
    userId,
    periodType,
    periodKey,
    ...data,
    source: "AUTO",
    parentKey
  });
}

async function upsertAnnualAndGenerate(req, res) {
  try {
    const {
      userId,
      yearKey, // FY2025-26 or CY2026
      vendorVisitTarget = 0,
      newVendorTarget = 0,
      salesTarget = 0,
      collectionTarget = 0,
      overwriteAutoOnly = true, // ✅ recommended default
    } = req.body || {};

    if (!userId || !yearKey) {
      return res.status(400).json({ message: "userId and yearKey are required" });
    }

    // 1) upsert annual as MANUAL
    const annual = await Target.findOneAndUpdate(
      { userId, periodType: "YEAR", periodKey: yearKey },
      {
        $set: {
          vendorVisitTarget: Number(vendorVisitTarget || 0),
          newVendorTarget: Number(newVendorTarget || 0),
          salesTarget: Number(salesTarget || 0),
          collectionTarget: Number(collectionTarget || 0),
          source: "MANUAL",
          parentKey: "",
        },
      },
      { upsert: true, new: true }
    );

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

    // Quarter keys depend on yearType:
    // - FY2025-26-Q1..Q4
    // - CY2026-Q1..Q4
    const qKeys = ["Q1", "Q2", "Q3", "Q4"].map((q) => `${yearKey}-${q}`);

    const monthKeys =
      yearKey.startsWith("FY")
        ? Array.from({ length: 12 }, (_, i) => `${yearKey}-${String(i + 1).padStart(2, "0")}`) // FY2025-26-01..12
        : Array.from({ length: 12 }, (_, i) => {
            // CY2026 => 2026-01..12
            const yr = Number(yearKey.replace("CY", ""));
            return `${yr}-${String(i + 1).padStart(2, "0")}`;
          });

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


module.exports = { upsertTarget, getMyTarget , getOneTargetForAdmin, listTargetsForAdmin,upsertAnnualAndGenerate};
