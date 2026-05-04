const Target = require("../models/Target");
const TargetSheetImport = require("../models/TargetSheetImport");
const User = require("../models/User");
const Segment = require("../models/Segment");
const { targetSheetImportSchema } = require("../utils/validators");

const MONTH_LABEL_TO_INDEX = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const TOTAL_LABELS = new Set([
  "total sales",
  "collection",
  "existing clinet visit",
  "existing client visit",
  "new client visit",
]);

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function uniqueNames(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map((v) => String(v || "").trim()).filter(Boolean)));
}

function parseNumber(value) {
  const text = String(value ?? "").replace(/[^0-9.\-]/g, "");
  if (!text) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getMatrixCell(matrix, rowIndex, colIndex) {
  return String(matrix?.[rowIndex]?.[colIndex] ?? "").trim();
}

function getYearStart(yearKey) {
  const match = String(yearKey || "").match(/(\d{4})/);
  return match ? Number(match[1]) : NaN;
}

function getFinancialMonthKeys(yearKey) {
  const startYear = getYearStart(yearKey);
  if (!Number.isFinite(startYear)) return [];

  return [
    ...Array.from({ length: 9 }, (_, i) => `${startYear}-${String(i + 4).padStart(2, "0")}`),
    ...Array.from({ length: 3 }, (_, i) => `${startYear + 1}-${String(i + 1).padStart(2, "0")}`),
  ];
}

function getQuarterKeys(yearKey) {
  const startYear = getYearStart(yearKey);
  if (!Number.isFinite(startYear)) return [];
  return [`${startYear}-Q1`, `${startYear}-Q2`, `${startYear}-Q3`, `${startYear}-Q4`];
}

function monthKeyFromLabel(label, yearKey) {
  const match = String(label || "").trim().match(/^([A-Za-z]{3})-(\d{2})$/);
  if (!match) return "";

  const monthIndex = MONTH_LABEL_TO_INDEX[match[1].toLowerCase()];
  const startYear = getYearStart(yearKey);
  if (!monthIndex || !Number.isFinite(startYear)) return "";

  const year = monthIndex >= 4 ? startYear : startYear + 1;
  return `${year}-${String(monthIndex).padStart(2, "0")}`;
}

function getDecimalPrecision(values) {
  let precision = 0;
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? "").trim();
    const match = text.match(/^-?\d+(?:\.(\d+))?$/);
    if (match?.[1]) {
      precision = Math.max(precision, match[1].length);
    }
  }
  return Math.min(Math.max(precision, 0), 4);
}

function allocateProportionally(values, total) {
  const safeTotal = Math.max(0, parseNumber(total));
  const weights = Array.isArray(values) ? values.map((v) => Math.max(0, parseNumber(v))) : [];

  if (!weights.length) return [];
  if (!weights.reduce((sum, value) => sum + value, 0) || !safeTotal) return weights.map(() => 0);

  const precision = getDecimalPrecision([total, ...values]);
  const scale = Math.pow(10, precision);
  const totalUnits = Math.round(safeTotal * scale);
  const weightUnits = weights.map((weight) => Math.round(weight * scale));
  const weightUnitTotal = weightUnits.reduce((sum, value) => sum + value, 0);

  if (!weightUnitTotal || !totalUnits) return weights.map(() => 0);

  const shares = weightUnits.map((weight, index) => {
    const exact = (totalUnits * weight) / weightUnitTotal;
    const base = Math.floor(exact);
    return {
      index,
      base,
      remainder: exact - base,
    };
  });

  let remainderUnits = totalUnits - shares.reduce((sum, item) => sum + item.base, 0);
  shares.sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let i = 0; i < shares.length && remainderUnits > 0; i += 1, remainderUnits -= 1) {
    shares[i].base += 1;
  }

  return shares
    .sort((a, b) => a.index - b.index)
    .map((item) => item.base / scale);
}

function detectSalespersonBlocks(matrix) {
  const headerRow = Array.isArray(matrix?.[2]) ? matrix[2] : [];
  const segmentRow = Array.isArray(matrix?.[3]) ? matrix[3] : [];
  const blocks = [];
  const salespersonStarts = [];

  for (let col = 0; col < headerRow.length; col += 1) {
    const salespersonName = String(headerRow[col] || "").trim();
    if (!salespersonName || normalizeName(salespersonName) === "all salesman targets") {
      continue;
    }
    salespersonStarts.push({ salespersonName, startCol: col });
  }

  for (let i = 0; i < salespersonStarts.length; i += 1) {
    const current = salespersonStarts[i];
    const nextStart = salespersonStarts[i + 1]?.startCol ?? headerRow.length;
    const segmentIndexes = [];

    for (let col = current.startCol; col < nextStart; col += 1) {
      const label = String(segmentRow[col] || "").trim();
      if (!label) break;
      if (TOTAL_LABELS.has(normalizeName(label))) break;
      segmentIndexes.push(col);
    }

    if (!segmentIndexes.length) {
      continue;
    }

    const metricColumns = {};
    for (let col = current.startCol + segmentIndexes.length; col < nextStart; col += 1) {
      const label = normalizeName(segmentRow[col]);
      if (!label) continue;
      if (TOTAL_LABELS.has(label)) {
        metricColumns[label] = col;
      }
    }

    blocks.push({
      salespersonName: current.salespersonName,
      startCol: current.startCol,
      segmentIndexes,
      segmentNames: segmentIndexes.map((col) => String(segmentRow[col] || "").trim()),
      metricColumns,
    });
  }

  return blocks;
}

function parseAssignmentsFromMatrix(matrix, yearKey) {
  const blocks = detectSalespersonBlocks(matrix);
  const assignments = [];

  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex] || [];
    const monthKey = monthKeyFromLabel(row[0], yearKey);
    if (!monthKey) continue;

    for (const block of blocks) {
      const salesShares = block.segmentIndexes.map((col) => parseNumber(row?.[col]));
      const totalSales = parseNumber(row?.[block.metricColumns["total sales"]]);
      const collectionTarget = parseNumber(row?.[block.metricColumns.collection]);
      const existingVisitTarget = parseNumber(row?.[block.metricColumns["existing clinet visit"]] ?? row?.[block.metricColumns["existing client visit"]]);
      const newVisitTarget = parseNumber(row?.[block.metricColumns["new client visit"]]);
      const salesTargetTotal = totalSales || salesShares.reduce((sum, value) => sum + value, 0);
      const collectionSplit = allocateProportionally(salesShares, collectionTarget);

      block.segmentNames.forEach((segmentName, index) => {
        assignments.push({
          salespersonName: block.salespersonName,
          segmentName,
          monthKey,
          vendorVisitTarget: existingVisitTarget,
          newVendorTarget: newVisitTarget,
          salesTarget: salesShares[index] || 0,
          collectionTarget: collectionSplit[index] || 0,
          salespersonSalesTarget: salesTargetTotal,
        });
      });
    }
  }

  return assignments;
}

async function buildLookupMap() {
  const [users, segments] = await Promise.all([
    User.find({ role: "sales" }).select("name email userId").lean(),
    Segment.find({}).select("name").lean(),
  ]);

  const userMap = new Map();
  for (const user of users) {
    const key = normalizeName(user?.name);
    if (key && !userMap.has(key)) {
      userMap.set(key, user);
    }
  }

  const segmentMap = new Map();
  for (const segment of segments) {
    const key = normalizeName(segment?.name);
    if (key && !segmentMap.has(key)) {
      segmentMap.set(key, segment);
    }
  }

  return { userMap, segmentMap };
}

function extractMissingNames(names, lookupMap) {
  return uniqueNames(names).filter((name) => !lookupMap.has(normalizeName(name)));
}

function groupAssignments(assignments) {
  const map = new Map();

  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    const key = [
      normalizeName(assignment.salespersonName),
      normalizeName(assignment.segmentName),
      String(assignment.monthKey || "").trim(),
    ].join("|");

    if (!key || key === "||") continue;

    const existing = map.get(key) || {
      ...assignment,
      vendorVisitTarget: 0,
      newVendorTarget: 0,
      salesTarget: 0,
      collectionTarget: 0,
    };

    existing.vendorVisitTarget += parseNumber(assignment.vendorVisitTarget);
    existing.newVendorTarget += parseNumber(assignment.newVendorTarget);
    existing.salesTarget += parseNumber(assignment.salesTarget);
    existing.collectionTarget += parseNumber(assignment.collectionTarget);
    map.set(key, existing);
  }

  return Array.from(map.values());
}

async function validateTargetSheetImportPayload(payload) {
  const parsed = targetSheetImportSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      errors: ["Invalid import payload"],
      details: parsed.error.issues.map((issue) => issue.message),
    };
  }

  const data = parsed.data;
  const assignments = Array.isArray(data.assignments) && data.assignments.length ? data.assignments : parseAssignmentsFromMatrix(data.matrix, data.yearKey);
  const { userMap, segmentMap } = await buildLookupMap();

  if (!assignments.length) {
    return {
      ok: false,
      errors: ["No monthly target rows were found in the uploaded sheet."],
      data: {
        ...data,
        assignments,
      },
      lookup: {
        salespersonCount: uniqueNames(data.salespersonNames).length,
        segmentCount: uniqueNames(data.segmentNames).length,
        assignmentCount: 0,
      },
    };
  }

  const missingSalespersons = extractMissingNames(
    [...data.salespersonNames, ...assignments.map((item) => item.salespersonName)],
    userMap
  );
  const missingSegments = extractMissingNames(
    [...data.segmentNames, ...assignments.map((item) => item.segmentName)],
    segmentMap
  );

  const errors = [];
  for (const name of missingSalespersons) {
    errors.push(`Salesperson "${name}" is not added in the system.`);
  }
  for (const name of missingSegments) {
    errors.push(`Segment "${name}" is not added in the system.`);
  }

  return {
    ok: errors.length === 0,
    errors,
    data: {
      ...data,
      assignments,
    },
    lookup: {
      salespersonCount: uniqueNames(data.salespersonNames).length,
      segmentCount: uniqueNames(data.segmentNames).length,
      assignmentCount: assignments.length,
    },
  };
}

async function deleteExistingTargetsForYear(yearKey) {
  const monthKeys = getFinancialMonthKeys(yearKey);
  const quarterKeys = getQuarterKeys(yearKey);
  const yearStartKey = String(yearKey || "").trim();

  const result = await Target.deleteMany({
    $or: [
      { periodType: "MONTH", periodKey: { $in: monthKeys } },
      { periodType: "QUARTER", periodKey: { $in: quarterKeys } },
      { periodType: "YEAR", periodKey: yearStartKey },
    ],
  });

  return result?.deletedCount || 0;
}

async function deleteTargetSheetImportByYear(req, res) {
  try {
    const { yearKey } = req.params;
    if (!yearKey) {
      return res.status(400).json({ message: "yearKey required" });
    }

    const [deletedTargets, deletedImport] = await Promise.all([
      deleteExistingTargetsForYear(yearKey),
      TargetSheetImport.findOneAndDelete({ yearKey }),
    ]);

    if (!deletedImport && !deletedTargets) {
      return res.status(404).json({ message: "Year import not found" });
    }

    return res.json({
      message: "Imported year and applied targets deleted successfully.",
      deletedTargets,
      deletedImport: Boolean(deletedImport),
      yearKey,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to delete imported year" });
  }
}

async function upsertTargetSheetImport(req, res) {
  try {
    const validation = await validateTargetSheetImportPayload(req.body);
    if (!validation.ok) {
      return res.status(400).json({
        message: validation.errors[0] || "Target sheet import validation failed",
        errors: validation.errors,
        details: validation.details || [],
      });
    }

    const data = validation.data;
    const assignments = groupAssignments(data.assignments);
    const { userMap, segmentMap } = await buildLookupMap();
    const monthTargetKeys = new Set();
    const targetUpserts = [];

    for (const assignment of assignments) {
      const user = userMap.get(normalizeName(assignment.salespersonName));
      const segment = segmentMap.get(normalizeName(assignment.segmentName));

      if (!user || !segment) {
        continue;
      }

      const key = `${String(user._id)}|${String(segment._id)}|${String(assignment.monthKey || "").trim()}`;
      monthTargetKeys.add(key);

      targetUpserts.push({
        updateOne: {
          filter: {
            userId: user._id,
            segmentId: segment._id,
            periodType: "MONTH",
            periodKey: String(assignment.monthKey || "").trim(),
          },
          update: {
            $set: {
              salespersonName: String(user.name || "").trim(),
              salespersonEmail: String(user.email || "").trim(),
              vendorVisitTarget: parseNumber(assignment.vendorVisitTarget),
              newVendorTarget: parseNumber(assignment.newVendorTarget),
              salesTarget: parseNumber(assignment.salesTarget),
              collectionTarget: parseNumber(assignment.collectionTarget),
              periodBasis: "FISCAL",
              source: "AUTO",
              parentKey: String(data.yearKey || "").trim(),
            },
            $setOnInsert: {
              userId: user._id,
              segmentId: segment._id,
              periodType: "MONTH",
              periodKey: String(assignment.monthKey || "").trim(),
            },
          },
          upsert: true,
        },
      });
    }

    const replacedTargetCount = await deleteExistingTargetsForYear(data.yearKey);

    if (targetUpserts.length) {
      await Target.bulkWrite(targetUpserts, { ordered: true });
    }

    const sheet = data.matrix.map((row) => (Array.isArray(row) ? row : []));
    const rowCount = sheet.length;
    const columnCount = sheet.reduce((max, row) => Math.max(max, row.length), 0);

    const updated = await TargetSheetImport.findOneAndUpdate(
      { yearKey: data.yearKey },
      {
        $set: {
          yearKey: data.yearKey,
          fileName: data.fileName,
          sheetName: data.sheetName,
          salespersonNames: uniqueNames(data.salespersonNames),
          segmentNames: uniqueNames(data.segmentNames),
          matrix: sheet,
          assignments,
          rowCount,
          columnCount,
          assignmentCount: assignments.length,
          appliedTargetCount: targetUpserts.length,
          replacedTargetCount,
          importedBy: req.user?._id || null,
          importedByName: String(req.user?.name || "").trim(),
          importedByEmail: String(req.user?.email || "").trim(),
          importedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return res.json({
      message: "Targets imported and applied successfully.",
      item: updated,
      appliedTargetCount: targetUpserts.length,
      replacedTargetCount,
    });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to import target sheet" });
  }
}

async function listTargetSheetImports(req, res) {
  try {
    const items = await TargetSheetImport.find({})
      .select("yearKey fileName sheetName rowCount columnCount assignmentCount appliedTargetCount replacedTargetCount importedByName importedByEmail importedAt createdAt updatedAt")
      .sort({ yearKey: -1, updatedAt: -1 })
      .lean();
    return res.json(items);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load target sheet imports" });
  }
}

async function getTargetSheetImportByYear(req, res) {
  try {
    const { yearKey } = req.params;
    if (!yearKey) {
      return res.status(400).json({ message: "yearKey required" });
    }

    const item = await TargetSheetImport.findOne({ yearKey }).lean();
    return res.json(item || null);
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load target sheet import" });
  }
}

module.exports = {
  deleteTargetSheetImportByYear,
  getTargetSheetImportByYear,
  listTargetSheetImports,
  upsertTargetSheetImport,
  validateTargetSheetImportPayload,
  parseAssignmentsFromMatrix,
};
