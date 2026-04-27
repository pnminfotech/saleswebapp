require("dotenv").config();

const { connectDB } = require("../src/config/db");
const Target = require("../src/models/Target");

function parseArgs(argv) {
  const args = { apply: false, cutoff: new Date() };

  for (const raw of argv) {
    if (raw === "--apply") {
      args.apply = true;
      continue;
    }

    if (raw === "--dry-run") {
      args.apply = false;
      continue;
    }

    if (raw.startsWith("--cutoff=")) {
      const value = raw.slice("--cutoff=".length).trim();
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        args.cutoff = parsed;
      }
    }
  }

  return args;
}

function legacyQuarterToFiscalKey(periodKey) {
  const raw = String(periodKey || "").trim().toUpperCase();
  const match = raw.match(/^(\d{4})-Q([1-4])$/);
  if (!match) return null;

  const year = Number(match[1]);
  const quarter = Number(match[2]);

  if (quarter === 1) return { periodKey: `${year - 1}-Q4`, parentKey: String(year - 1) };
  if (quarter === 2) return { periodKey: `${year}-Q1`, parentKey: String(year) };
  if (quarter === 3) return { periodKey: `${year}-Q2`, parentKey: String(year) };
  return { periodKey: `${year}-Q3`, parentKey: String(year) };
}

function buildGroupKey(doc, mapped) {
  return [String(doc.userId || ""), String(doc.segmentId || ""), mapped.periodKey].join("|");
}

async function main() {
  const { apply, cutoff } = parseArgs(process.argv.slice(2));
  await connectDB();

  const candidates = await Target.find({
    periodType: "QUARTER",
    periodBasis: { $ne: "FISCAL" },
    periodKey: { $regex: /^\d{4}-Q[1-4]$/i },
    createdAt: { $lt: cutoff },
  }).sort({ createdAt: 1 });

  const groups = new Map();
  for (const doc of candidates) {
    const mapped = legacyQuarterToFiscalKey(doc.periodKey);
    if (!mapped) continue;

    const groupKey = buildGroupKey(doc, mapped);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        userId: String(doc.userId || ""),
        segmentId: String(doc.segmentId || ""),
        legacyKeys: new Set(),
        docs: [],
        mapped,
      });
    }

    const group = groups.get(groupKey);
    group.legacyKeys.add(String(doc.periodKey || ""));
    group.docs.push(doc);
  }

  let movedDocs = 0;
  let movedGroups = 0;
  const conflicts = [];

  for (const group of groups.values()) {
    const existing = await Target.findOne({
      userId: group.userId,
      segmentId: group.segmentId,
      periodType: "QUARTER",
      periodKey: group.mapped.periodKey,
    });

    if (existing) {
      conflicts.push({
        userId: group.userId,
        segmentId: group.segmentId,
        from: Array.from(group.legacyKeys).join(", "),
        to: group.mapped.periodKey,
        reason: "A fiscal quarter target already exists for this salesperson and segment.",
      });
      continue;
    }

    movedGroups += 1;
    movedDocs += group.docs.length;

    if (!apply) {
      continue;
    }

    const [primary, ...rest] = group.docs;
    const totals = group.docs.reduce(
      (acc, doc) => {
        acc.vendorVisitTarget += Number(doc.vendorVisitTarget || 0);
        acc.newVendorTarget += Number(doc.newVendorTarget || 0);
        acc.salesTarget += Number(doc.salesTarget || 0);
        acc.collectionTarget += Number(doc.collectionTarget || 0);
        return acc;
      },
      {
        vendorVisitTarget: 0,
        newVendorTarget: 0,
        salesTarget: 0,
        collectionTarget: 0,
      }
    );

    primary.periodKey = group.mapped.periodKey;
    primary.parentKey = group.mapped.parentKey;
    primary.periodBasis = "FISCAL";
    primary.vendorVisitTarget = totals.vendorVisitTarget;
    primary.newVendorTarget = totals.newVendorTarget;
    primary.salesTarget = totals.salesTarget;
    primary.collectionTarget = totals.collectionTarget;
    await primary.save();

    if (rest.length) {
      await Target.deleteMany({ _id: { $in: rest.map((doc) => doc._id) } });
    }
  }

  const mode = apply ? "APPLY" : "DRY-RUN";
  console.log(`[${mode}] Legacy quarter groups found: ${groups.size}`);
  console.log(`[${mode}] Groups that would move: ${movedGroups}`);
  console.log(`[${mode}] Documents involved: ${movedDocs}`);

  if (conflicts.length) {
    console.log(`[${mode}] Conflicts skipped: ${conflicts.length}`);
    for (const item of conflicts.slice(0, 20)) {
      console.log(`- user=${item.userId} segment=${item.segmentId} ${item.from} -> ${item.to} (${item.reason})`);
    }
    if (conflicts.length > 20) {
      console.log(`... and ${conflicts.length - 20} more`);
    }
  }

  if (!apply) {
    console.log("Run again with --apply to write the migration.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
