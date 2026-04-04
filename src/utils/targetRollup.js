const mongoose = require("mongoose");

const Target = require("../models/Target");
const User = require("../models/User");
const Segment = require("../models/Segment");
const { getRange } = require("./period");

function normalizeKey(value) {
  return String(value || "").trim().toLowerCase();
}

function isObjectIdLike(value) {
  return mongoose.Types.ObjectId.isValid(String(value || "").trim());
}

function toObjectId(value) {
  return new mongoose.Types.ObjectId(String(value));
}

function monthKeysInRange(from, to) {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const keys = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  const limit = new Date(end.getFullYear(), end.getMonth(), 1);

  while (cursor <= limit) {
    keys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return keys;
}

function quarterKeysForYearKey(yearKey) {
  const raw = String(yearKey || "").trim().toUpperCase();
  const fy = raw.match(/^FY(\d{4})$/);
  const cy = raw.match(/^CY(\d{4})$/);

  if (fy) {
    const y = fy[1];
    return [`FY${y}-Q1`, `FY${y}-Q2`, `FY${y}-Q3`, `FY${y}-Q4`];
  }

  if (cy) {
    const y = cy[1];
    return [`CY${y}-Q1`, `CY${y}-Q2`, `CY${y}-Q3`, `CY${y}-Q4`];
  }

  const year = raw;
  return [`${year}-Q1`, `${year}-Q2`, `${year}-Q3`, `${year}-Q4`];
}

function makeTargetKey(doc) {
  return `${String(doc?.userId || "").trim()}|${String(doc?.segmentId || "").trim()}`;
}

function pushDoc(map, doc, sourceOverride) {
  const key = makeTargetKey(doc);
  if (!key || key === "|") return;

  const existing = map.get(key) || {
    userId: String(doc?.userId || "").trim(),
    segmentId: String(doc?.segmentId || "").trim(),
    periodType: String(doc?.periodType || "").trim(),
    periodKey: String(doc?.periodKey || "").trim(),
    vendorVisitTarget: 0,
    newVendorTarget: 0,
    salesTarget: 0,
    collectionTarget: 0,
    source: sourceOverride || String(doc?.source || "MANUAL").trim() || "MANUAL",
    parentKey: String(doc?.parentKey || "").trim(),
  };

  existing.vendorVisitTarget += Number(doc?.vendorVisitTarget || 0);
  existing.newVendorTarget += Number(doc?.newVendorTarget || 0);
  existing.salesTarget += Number(doc?.salesTarget || 0);
  existing.collectionTarget += Number(doc?.collectionTarget || 0);

  if (sourceOverride) {
    existing.source = sourceOverride;
  } else if (!existing.source) {
    existing.source = String(doc?.source || "MANUAL").trim() || "MANUAL";
  }

  map.set(key, existing);
}

async function fetchTargetDocs(filter) {
  return Target.find(filter).lean();
}

async function resolveTargetRows({ periodType, periodKey, userId }) {
  const pt = String(periodType || "MONTH").toUpperCase();
  const pk = String(periodKey || "").trim();
  if (!pk) return [];

  const baseFilter = { periodType: pt, periodKey: pk };
  if (userId) {
    if (!isObjectIdLike(userId)) {
      throw new Error("Invalid userId");
    }
    baseFilter.userId = toObjectId(userId);
  }

  const exactDocs = await fetchTargetDocs(baseFilter);
  const finalMap = new Map();

  for (const doc of exactDocs) {
    pushDoc(finalMap, doc);
  }

  if (pt === "QUARTER" || pt === "YEAR") {
    const { from, to } = getRange(pt, pk);
    const monthKeys = monthKeysInRange(from, to);

    if (pt === "YEAR") {
      const quarterKeys = quarterKeysForYearKey(pk);
      const quarterFilter = {
        periodType: "QUARTER",
        periodKey: { $in: quarterKeys },
      };
      const monthFilter = {
        periodType: "MONTH",
        periodKey: { $in: monthKeys },
      };
      if (userId) {
        quarterFilter.userId = toObjectId(userId);
        monthFilter.userId = toObjectId(userId);
      }

      const [quarterDocs, monthDocs] = await Promise.all([fetchTargetDocs(quarterFilter), fetchTargetDocs(monthFilter)]);

      const fallbackMap = new Map();
      for (const doc of quarterDocs) pushDoc(fallbackMap, doc, "AUTO");
      for (const doc of monthDocs) {
        const key = makeTargetKey(doc);
        if (fallbackMap.has(key)) continue;
        pushDoc(fallbackMap, doc, "AUTO");
      }

      for (const [key, row] of fallbackMap.entries()) {
        if (!finalMap.has(key)) finalMap.set(key, row);
      }
    } else {
      const monthFilter = {
        periodType: "MONTH",
        periodKey: { $in: monthKeys },
      };
      if (userId) monthFilter.userId = toObjectId(userId);

      const monthDocs = await fetchTargetDocs(monthFilter);
      const fallbackMap = new Map();
      for (const doc of monthDocs) pushDoc(fallbackMap, doc, "AUTO");

      for (const [key, row] of fallbackMap.entries()) {
        if (!finalMap.has(key)) finalMap.set(key, row);
      }
    }
  }

  const rows = Array.from(finalMap.values());
  if (!rows.length) return [];

  const userIds = Array.from(
    new Set(rows.map((row) => String(row.userId || "").trim()).filter((id) => isObjectIdLike(id)))
  );
  const segmentIds = Array.from(
    new Set(rows.map((row) => String(row.segmentId || "").trim()).filter((id) => isObjectIdLike(id)))
  );

  const [users, segments] = await Promise.all([
    userIds.length ? User.find({ _id: { $in: userIds } }).select("name email").lean() : [],
    segmentIds.length ? Segment.find({ _id: { $in: segmentIds } }).select("name").lean() : [],
  ]);

  const userMap = new Map(users.map((u) => [String(u._id), u]));
  const segmentMap = new Map(segments.map((s) => [String(s._id), s]));

  return rows
    .map((row) => {
      const user = userMap.get(String(row.userId)) || null;
      const segment = segmentMap.get(String(row.segmentId)) || null;
      return {
        ...row,
        userId: user ? { _id: user._id, name: user.name || "", email: user.email || "" } : { _id: row.userId, name: "", email: "" },
        segmentId: segment ? { _id: segment._id, name: segment.name || "" } : { _id: row.segmentId, name: "" },
      };
    })
    .sort((a, b) => {
      const left = `${String(a.segmentId?.name || "").toLowerCase()}|${String(a.userId?.name || "").toLowerCase()}`;
      const right = `${String(b.segmentId?.name || "").toLowerCase()}|${String(b.userId?.name || "").toLowerCase()}`;
      return left.localeCompare(right);
    });
}

function summarizeTargetRows(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (acc, row) => {
      acc.vendorVisitTarget += Number(row?.vendorVisitTarget || 0);
      acc.newVendorTarget += Number(row?.newVendorTarget || 0);
      acc.salesTarget += Number(row?.salesTarget || 0);
      acc.collectionTarget += Number(row?.collectionTarget || 0);
      return acc;
    },
    {
      vendorVisitTarget: 0,
      newVendorTarget: 0,
      salesTarget: 0,
      collectionTarget: 0,
    }
  );
}

module.exports = {
  resolveTargetRows,
  summarizeTargetRows,
};
