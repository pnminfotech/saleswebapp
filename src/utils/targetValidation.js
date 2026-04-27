const Target = require("../models/Target");

const TARGET_FIELDS = ["vendorVisitTarget", "newVendorTarget", "salesTarget", "collectionTarget"];

function num(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function pickTargetValues(doc) {
  if (!doc) {
    return null;
  }

  return TARGET_FIELDS.reduce(
    (acc, field) => {
      acc[field] = num(doc[field]);
      return acc;
    },
    {
      _id: String(doc._id || ""),
    }
  );
}

function emptyTotals() {
  return TARGET_FIELDS.reduce(
    (acc, field) => {
      acc[field] = 0;
      return acc;
    },
    {}
  );
}

function addTotals(target, source) {
  for (const field of TARGET_FIELDS) {
    target[field] += num(source?.[field]);
  }
  return target;
}

function totalsFromDocs(docs) {
  return (Array.isArray(docs) ? docs : []).reduce((acc, doc) => addTotals(acc, doc), emptyTotals());
}

function subtractTotals(left, right) {
  return TARGET_FIELDS.reduce(
    (acc, field) => {
      acc[field] = Math.max(num(left?.[field]) - num(right?.[field]), 0);
      return acc;
    },
    {}
  );
}

function monthKeyToQuarterKey(monthKey) {
  const match = String(monthKey || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) return "";

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return "";

  const fiscalYear = month >= 4 ? year : year - 1;
  const quarter = month >= 4 && month <= 6 ? 1 : month <= 9 ? 2 : month <= 12 ? 3 : 4;
  return `${fiscalYear}-Q${quarter}`;
}

function monthKeyToYearKey(monthKey) {
  const match = String(monthKey || "").trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  return String(month >= 4 ? year : year - 1);
}

function quarterKeyToMonthKeys(quarterKey) {
  const raw = String(quarterKey || "").trim().toUpperCase();
  const match = raw.match(/^(?:FY\s*)?(\d{4})-Q([1-4])$/);
  const cyMatch = raw.match(/^CY\s*(\d{4})-Q([1-4])$/);
  const parts = match || cyMatch;
  if (!parts) return [];

  const yearLabel = Number(parts[1]);
  const quarter = Number(parts[2]);
  const startMonth = quarter === 1 ? 4 : quarter === 2 ? 7 : quarter === 3 ? 10 : 1;
  const startYear = quarter === 4 ? yearLabel + 1 : yearLabel;

  return [startMonth, startMonth + 1, startMonth + 2].map((month) => `${startYear}-${pad2(month)}`);
}

function getYearKeyFromQuarterKey(quarterKey) {
  const raw = String(quarterKey || "").trim();
  const match = raw.match(/^(?:FY\s*)?(\d{4})-Q[1-4]$/i);
  const cyMatch = raw.match(/^CY\s*(\d{4})-Q[1-4]$/i);
  return match ? match[1] : cyMatch ? cyMatch[1] : raw.split("-Q")[0];
}

function sameId(a, b) {
  return String(a || "").trim() === String(b || "").trim();
}

function samePeriod(doc, periodType, periodKey) {
  return (
    String(doc?.periodType || "").trim().toUpperCase() === String(periodType || "").trim().toUpperCase() &&
    String(doc?.periodKey || "").trim() === String(periodKey || "").trim()
  );
}

function buildConstraintError(periodLabel, field, capValue, assignedValue, requestedValue) {
  const cap = num(capValue);
  const assigned = num(assignedValue);
  const requested = num(requestedValue);
  const remaining = Math.max(cap - assigned, 0);
  return `${periodLabel} ${field} limit is ${cap.toLocaleString("en-IN")}. Already assigned ${assigned.toLocaleString("en-IN")}, remaining ${remaining.toLocaleString("en-IN")}. Requested ${requested.toLocaleString("en-IN")} would exceed the limit.`;
}

async function loadTargetScope({ userId, segmentId }) {
  return Target.find({ userId, segmentId }).lean();
}

function buildTargetContextFromDocs({ docs, selectedDoc, periodType, periodKey }) {
  const pt = String(periodType || "").trim().toUpperCase();
  const pk = String(periodKey || "").trim();
  const currentDoc = selectedDoc || null;
  const currentDocId = currentDoc?._id ? String(currentDoc._id) : "";

  const quarterKey = pt === "MONTH" ? monthKeyToQuarterKey(pk) : pt === "QUARTER" ? pk : "";
  const yearKey = pt === "MONTH" ? monthKeyToYearKey(pk) : pt === "QUARTER" ? getYearKeyFromQuarterKey(pk) : pk;

  const parentQuarterDoc =
    pt === "MONTH"
      ? docs.find((doc) => samePeriod(doc, "QUARTER", quarterKey)) || null
      : null;
  const parentYearDoc =
    pt === "MONTH"
      ? docs.find((doc) => samePeriod(doc, "YEAR", yearKey)) || null
      : pt === "QUARTER"
        ? docs.find((doc) => samePeriod(doc, "YEAR", yearKey)) || null
        : null;

  const quarterMonthDocs = quarterKey
    ? docs.filter((doc) => {
        if (String(doc?.periodType || "").trim().toUpperCase() !== "MONTH") return false;
        if (pt === "MONTH" && sameId(doc?._id, currentDocId)) return false;
        return monthKeyToQuarterKey(doc?.periodKey) === quarterKey;
      })
    : [];

  const yearMonthDocs = yearKey
    ? docs.filter((doc) => {
        if (String(doc?.periodType || "").trim().toUpperCase() !== "MONTH") return false;
        if (monthKeyToYearKey(doc?.periodKey) !== yearKey) return false;
        if (pt === "MONTH" && sameId(doc?._id, currentDocId)) return false;
        return true;
      })
    : [];

  const yearQuarterCaps = yearKey
    ? docs.filter((doc) => String(doc?.periodType || "").trim().toUpperCase() === "QUARTER" && getYearKeyFromQuarterKey(doc?.periodKey) === yearKey)
    : [];

  const quarterUsage = totalsFromDocs(quarterMonthDocs);
  const yearUsage = totalsFromDocs(yearMonthDocs);

  const parentQuarterTarget = pickTargetValues(parentQuarterDoc);
  const parentYearTarget = pickTargetValues(parentYearDoc);
  const currentTarget = pickTargetValues(currentDoc);

  return {
    selection: {
      periodType: pt,
      periodKey: pk,
      quarterKey,
      yearKey,
    },
    currentTarget,
    parentQuarterTarget,
    parentYearTarget,
    quarterUsage,
    yearUsage,
    yearQuarterCaps: yearQuarterCaps.map((doc) => ({
      _id: String(doc._id || ""),
      periodKey: String(doc.periodKey || ""),
      ...pickTargetValues(doc),
    })),
  };
}

async function buildTargetContext({ userId, segmentId, periodType, periodKey }) {
  const docs = await loadTargetScope({ userId, segmentId });
  const selectedDoc = docs.find((doc) => samePeriod(doc, periodType, periodKey)) || null;
  return buildTargetContextFromDocs({ docs, selectedDoc, periodType, periodKey });
}

async function validateTargetWrite({ userId, segmentId, periodType, periodKey, values }) {
  const context = await buildTargetContext({ userId, segmentId, periodType, periodKey });
  const pt = context.selection.periodType;

  const candidate = TARGET_FIELDS.reduce(
    (acc, field) => {
      acc[field] = num(values?.[field]);
      return acc;
    },
    {}
  );

  const errors = [];
  const periodLabel = pt === "MONTH" ? "Monthly" : pt === "QUARTER" ? "Quarterly" : "Annual";

  for (const field of TARGET_FIELDS) {
    if (candidate[field] < 0) {
      errors.push(`${periodLabel} ${field} cannot be negative.`);
    }
  }

  if (errors.length) {
    return { ok: false, errors, context };
  }

  if (pt === "MONTH") {
    const quarterCap = context.parentQuarterTarget;
    const yearCap = context.parentYearTarget;
    const quarterAfterSave = addTotals({ ...context.quarterUsage }, candidate);
    const yearAfterSave = addTotals({ ...context.yearUsage }, candidate);

    for (const field of TARGET_FIELDS) {
      if (quarterCap && num(quarterAfterSave[field]) > num(quarterCap[field])) {
        errors.push(buildConstraintError("Quarter", field, quarterCap[field], context.quarterUsage[field], candidate[field]));
      }
      if (yearCap && num(yearAfterSave[field]) > num(yearCap[field])) {
        errors.push(buildConstraintError("Annual", field, yearCap[field], context.yearUsage[field], candidate[field]));
      }
    }
  }

  if (pt === "QUARTER") {
    const yearCap = context.parentYearTarget;
    for (const field of TARGET_FIELDS) {
      if (num(candidate[field]) < num(context.quarterUsage[field])) {
        errors.push(
          `${periodLabel} ${field} must be at least the already assigned monthly total of ${num(context.quarterUsage[field]).toLocaleString("en-IN")} for ${context.selection.quarterKey}.`
        );
      }
      if (yearCap && num(candidate[field]) > num(yearCap[field])) {
        errors.push(
          `${periodLabel} ${field} cannot be greater than the annual limit of ${num(yearCap[field]).toLocaleString("en-IN")} for ${context.selection.yearKey}.`
        );
      }
    }
  }

  if (pt === "YEAR") {
    const maxQuarterCaps = context.yearQuarterCaps.reduce(
      (acc, doc) => {
        for (const field of TARGET_FIELDS) {
          acc[field] = Math.max(acc[field], num(doc[field]));
        }
        return acc;
      },
      emptyTotals()
    );

    for (const field of TARGET_FIELDS) {
      if (num(candidate[field]) < num(context.yearUsage[field])) {
        errors.push(
          `${periodLabel} ${field} must be at least the already assigned monthly total of ${num(context.yearUsage[field]).toLocaleString("en-IN")} for ${context.selection.yearKey}.`
        );
      }
      if (num(candidate[field]) < num(maxQuarterCaps[field])) {
        errors.push(
          `${periodLabel} ${field} must also stay above the largest quarter target (${num(maxQuarterCaps[field]).toLocaleString("en-IN")}) inside ${context.selection.yearKey}.`
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    context,
  };
}

module.exports = {
  TARGET_FIELDS,
  addTotals,
  buildTargetContext,
  buildTargetContextFromDocs,
  buildConstraintError,
  monthKeyToQuarterKey,
  monthKeyToYearKey,
  quarterKeyToMonthKeys,
  subtractTotals,
  totalsFromDocs,
  validateTargetWrite,
};
