// // src/routes/reportRoutes.js
// const router = require("express").Router();
// const DailyCustomerReport = require("../models/DailyCustomerReport");
// const Target = require("../models/Target");
// const authModule = require("../middleware/auth");
// const requireRoleModule = require("../middleware/requireRole");
// const reportController = require("../controllers/reportController");

// // ✅ ADD THESE
// // const Target = require("../models/targetModel"); 
// // const DailyReport = require("../models/dailyCustomerReportModel"); 

// const auth = typeof authModule === "function" ? authModule : authModule.auth;
// const requireRole =
//   typeof requireRoleModule === "function"
//     ? requireRoleModule
//     : requireRoleModule.requireRole;

// router.get(
//   "/performance",
//   auth,
//   requireRole("admin"),
//   reportController.adminPerformanceReport
// );

// router.get(
//   "/customerwise",
//   auth,
//   requireRole("admin"),
//   reportController.adminCustomerWiseReport
// );

// // ✅ Correct path
// router.get("/performance/me", auth, async (req, res) => {
//   try {
//     const { periodType, periodKey } = req.query;
//     const userId = req.user.id;

//     const target = await Target.findOne({ userId, periodType, periodKey }).lean();

//     const agg = await DailyCustomerReport.aggregate([
//       { $match: { userId, periodType, periodKey } },
//       {
//         $group: {
//           _id: null,
//           vendorsVisited: { $sum: { $ifNull: ["$vendorsVisited", 0] } },
//           newVendorsAdded: { $sum: { $ifNull: ["$newVendorsAdded", 0] } },
//           sales: { $sum: { $ifNull: ["$sales", 0] } },
//           collection: { $sum: { $ifNull: ["$collection", 0] } },
//           runningKm: { $sum: { $ifNull: ["$netKm", 0] } },   // confirm field name
//           runningCost: { $sum: { $ifNull: ["$runningCost", 0] } },
//         },
//       },
//     ]);

//     const actual = agg?.[0] || {
//       runningKm: 0,
//       runningCost: 0,
//       vendorsVisited: 0,
//       newVendorsAdded: 0,
//       sales: 0,
//       collection: 0,
//     };

//     res.json({ target: target || null, actual });
//   } catch (err) {
//     console.error("performance/me error:", err);
//     res.status(500).json({ message: err.message || "Server error" });
//   }
// });

// module.exports = router;



// src/routes/reportRoutes.js
const router = require("express").Router();
const mongoose = require("mongoose");

const DailyCustomerReport = require("../models/DailyCustomerReport");
const Customer = require("../models/Customer");
const Segment = require("../models/Segment");
const authModule = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const reportController = require("../controllers/reportController");
const { resolveTargetRows, summarizeTargetRows } = require("../utils/targetRollup");
const { buildCustomerLookupMap, buildCustomerSelectFields } = require("../utils/customerMaster");

const auth = typeof authModule === "function" ? authModule : authModule.auth;

// Admin reports
router.get("/performance", auth, requireRole("admin"), reportController.adminPerformanceReport);
router.get("/customerwise", auth, requireRole("admin"), reportController.adminCustomerWiseReport);
router.get("/lead-conversion", auth, requireRole("admin"), reportController.adminLeadConversionReport);
router.get("/segment-wise", auth, requireRole("admin"), reportController.adminSegmentWiseSalesReport);
router.get("/segment-wise/customerwise", auth, requireRole("admin"), reportController.adminSegmentWiseCustomerReport);
router.get("/customer-tracker/me", auth, requireRole("sales"), reportController.myCustomerCollectionTracker);

function monthRange(yyyyMM) {
  const [y, m] = yyyyMM.split("-").map(Number);
  const start = `${y}-${String(m).padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(y, m, 1)); // next month (m is 1-based here, Date month is 0-based)
  // easier: use JS date properly
  const end = new Date(Date.UTC(y, m, 1)); // m as month index? We'll build safely below
  const end2 = new Date(Date.UTC(y, m - 1 + 1, 1)); // next month 1st
  const endKey = end2.toISOString().slice(0, 10);
  return { startKey: start, endKey };
}

function quarterRange(qKey) {
  const raw = String(qKey || "").toUpperCase().trim();
  const fy = raw.match(/^(?:FY\s*)?(\d{4})-Q([1-4])$/);
  const cy = raw.match(/^CY\s*(\d{4})-Q([1-4])$/);

  if (fy || cy) {
    const fyStart = Number((fy || cy)[1]);
    const q = Number((fy || cy)[2]);
    if (q === 1) return { startKey: `${fyStart}-04-01`, endKey: `${fyStart}-07-01` };
    if (q === 2) return { startKey: `${fyStart}-07-01`, endKey: `${fyStart}-10-01` };
    if (q === 3) return { startKey: `${fyStart}-10-01`, endKey: `${fyStart + 1}-01-01` };
    return { startKey: `${fyStart + 1}-01-01`, endKey: `${fyStart + 1}-04-01` };
  }

  // backward compatibility: plain "2026-Q1" now means FY2026-27
  const [yStr, qStr] = raw.split("-");
  const y = Number(yStr);
  const q = Number(String(qStr || "").replace("Q", ""));
  const startMonth = q === 1 ? 4 : q === 2 ? 7 : q === 3 ? 10 : 1;
  const startYear = q === 4 ? y + 1 : y;
  const endMonth = startMonth + 3;
  const endY = endMonth > 12 ? startYear + 1 : startYear;
  const endM = endMonth > 12 ? endMonth - 12 : endMonth;
  const endKey = `${endY}-${String(endM).padStart(2, "0")}-01`;
  return { startKey: `${startYear}-${String(startMonth).padStart(2, "0")}-01`, endKey };
}

function yearRange(yKey) {
  const raw = String(yKey || "").toUpperCase().trim();

  // FY2026 or plain 2026 => Apr 1, 2026 to Apr 1, 2027
  const fy = raw.match(/^(?:FY\s*)?(\d{4})(?:\s*[-/]\s*\d{2,4})?$/);
  if (fy) {
    const y = Number(fy[1]);
    return { startKey: `${y}-04-01`, endKey: `${y + 1}-04-01` };
  }

  // CY2026 => Jan 1, 2026 to Jan 1, 2027
  const cy = raw.match(/^CY(\d{4})$/);
  const y = Number(cy ? cy[1] : raw);
  return { startKey: `${y}-01-01`, endKey: `${y + 1}-01-01` };
}

function periodToRange(periodType, periodKey) {
  if (periodType === "MONTH") return monthRange(periodKey);
  if (periodType === "QUARTER") return quarterRange(periodKey);
  return yearRange(periodKey);
}

function normalizeSegmentKey(value) {
  return String(value || "").trim().toLowerCase();
}

function toTitleCase(value) {
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

async function buildCustomerSegmentLookup() {
  const customers = await Customer.find({}).select(buildCustomerSelectFields()).lean();
  return buildCustomerLookupMap(customers);
}

router.get("/performance/me", auth, async (req, res) => {
  try {
    const { periodType, periodKey } = req.query;
    if (!periodType || !periodKey) {
      return res.status(400).json({ message: "periodType and periodKey are required" });
    }

    const userId = req.user.id;
    const userObjId = new mongoose.Types.ObjectId(userId);
    const targetRows = await resolveTargetRows({ periodType, periodKey, userId });
    const target = summarizeTargetRows(targetRows);

    // 2) date range from periodType/key
    const { startKey, endKey } = periodToRange(periodType, periodKey);

    // 3) aggregate daily reports by date range
    const agg = await DailyCustomerReport.aggregate([
      {
        $match: {
          userId: userObjId,                 // if userId stored as ObjectId
          reportDateKey: { $gte: startKey, $lt: endKey },
        },
      },
      {
        $project: {
          // rows array safe
          rows: { $ifNull: ["$rows", []] },

          // km
          runningKm: {
            $cond: [
              { $and: [{ $isNumber: "$openingKm" }, { $isNumber: "$closingKm" }] },
              { $subtract: ["$closingKm", "$openingKm"] },
              { $ifNull: ["$netKm", 0] },
            ],
          },

          // derived counts
          vendorsVisited: { $size: { $ifNull: ["$rows", []] } },

          newVendorsAdded: {
            $size: {
              $filter: {
                input: { $ifNull: ["$rows", []] },
                as: "r",
                cond: { $eq: ["$$r.newOrExisting", "New"] },
              },
            },
          },

          // sum of row amounts (adjust keys to your row schema)
          salesInvoiced: {
            $sum: {
              $map: {
                input: { $ifNull: ["$rows", []] },
                as: "r",
                in: {
                  $ifNull: ["$$r.salesInvoiced", 0],
                },
              },
            },
          },

          collection: {
            $sum: {
              $map: {
                input: { $ifNull: ["$rows", []] },
                as: "r",
                in: { $ifNull: ["$$r.poReceived", 0] },
              },
            },
          },

          // if you want PO separately:
          poReceived: {
            $sum: {
              $map: {
                input: { $ifNull: ["$rows", []] },
                as: "r",
                in: { $ifNull: ["$$r.poReceived", 0] },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          runningKm: { $sum: "$runningKm" },
          vendorsVisited: { $sum: "$vendorsVisited" },
          newVendorsAdded: { $sum: "$newVendorsAdded" },
          salesInvoiced: { $sum: "$salesInvoiced" },
          collection: { $sum: "$collection" },
          poReceived: { $sum: "$poReceived" },
        },
      },
    ]);

    const actual = agg?.[0] || {
      runningKm: 0,
      vendorsVisited: 0,
      newVendorsAdded: 0,
      salesInvoiced: 0,
      sales: 0,
      collection: 0,
      poReceived: 0,
    };

    actual.sales = actual.salesInvoiced;

    return res.json({ target: target || null, actual });
  } catch (err) {
    console.error("performance/me error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
});

router.get("/performance/me/segments", auth, async (req, res) => {
  try {
    const { periodType, periodKey } = req.query;
    if (!periodType || !periodKey) {
      return res.status(400).json({ message: "periodType and periodKey are required" });
    }

    const userId = req.user.id;
    const { startKey, endKey } = periodToRange(periodType, periodKey);
    const customerLookup = await buildCustomerSegmentLookup();
    const targetRows = await resolveTargetRows({ periodType, periodKey, userId });

    const actualRows = await DailyCustomerReport.aggregate([
        {
          $match: {
            userId: new mongoose.Types.ObjectId(userId),
            reportDateKey: { $gte: startKey, $lt: endKey },
          },
        },
        { $unwind: { path: "$rows", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            customerName: {
              $trim: {
                input: { $ifNull: ["$rows.customerName", ""] },
              },
            },
            segmentName: {
              $trim: {
                input: { $ifNull: ["$rows.segment", ""] },
              },
            },
            area: {
              $trim: {
                input: { $ifNull: ["$rows.area", ""] },
              },
            },
            newOrExisting: { $ifNull: ["$rows.newOrExisting", "Existing"] },
            orderGenerated: { $ifNull: ["$rows.orderGenerated", 0] },
            salesInvoiced: {
              $ifNull: ["$rows.salesInvoiced", 0],
            },
            collection: { $ifNull: ["$rows.poReceived", 0] },
          },
        },
      ]);

    const segmentIds = Array.from(
      new Set(
        targetRows
          .map((doc) => String(doc?.segmentId?._id || doc?.segmentId || "").trim())
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      )
    );
    const segmentDocs = segmentIds.length
      ? await Segment.find({ _id: { $in: segmentIds } }).select("name").lean()
      : [];
    const segmentLookup = new Map(segmentDocs.map((doc) => [String(doc?._id), String(doc?.name || "").trim()]));

    const actualMap = new Map();
    for (const row of actualRows) {
      const customerKey = normalizeSegmentKey(row?.customerName);
      const lookup = customerLookup.get(customerKey);
      const segmentName = String(row?.segmentName || lookup?.segment || "").trim();
      const key = normalizeSegmentKey(segmentName) || "__unassigned__";
      const existing = actualMap.get(key) || {
        segmentName,
        vendorsVisited: 0,
        newVendorsAdded: 0,
        orderGenerated: 0,
        salesInvoiced: 0,
        collection: 0,
      };

      existing.segmentName = existing.segmentName || segmentName;
      existing.vendorsVisited += 1;
      if (String(row?.newOrExisting || "").trim() === "New") {
        existing.newVendorsAdded += 1;
      }
      existing.orderGenerated += Number(row?.orderGenerated || 0);
      existing.salesInvoiced += Number(row?.salesInvoiced || 0);
      existing.collection += Number(row?.collection || 0);
      actualMap.set(key, existing);
    }

    const targetMap = new Map();
    for (const doc of targetRows) {
      const segmentId = String(doc?.segmentId?._id || doc?.segmentId || "").trim();
      const segmentName = String(segmentLookup.get(segmentId) || doc?.segmentId?.name || "").trim();
      const key = normalizeSegmentKey(segmentName) || "__unassigned__";
      const existing = targetMap.get(key) || {
        segmentName,
        vendorVisitTarget: 0,
        newVendorTarget: 0,
        salesTarget: 0,
        collectionTarget: 0,
      };

      existing.segmentName = existing.segmentName || segmentName;
      existing.vendorVisitTarget += Number(doc?.vendorVisitTarget || 0);
      existing.newVendorTarget += Number(doc?.newVendorTarget || 0);
      existing.salesTarget += Number(doc?.salesTarget || 0);
      existing.collectionTarget += Number(doc?.collectionTarget || 0);
      targetMap.set(key, existing);
    }

    const keys = new Set([...actualMap.keys(), ...targetMap.keys()]);
    const items = Array.from(keys)
      .sort((a, b) => {
        const left = (actualMap.get(a)?.segmentName || targetMap.get(a)?.segmentName || toTitleCase(a)).toLowerCase();
        const right = (actualMap.get(b)?.segmentName || targetMap.get(b)?.segmentName || toTitleCase(b)).toLowerCase();
        return left.localeCompare(right);
      })
      .map((key) => {
        const actual = actualMap.get(key) || {
          segmentName: "",
          vendorsVisited: 0,
          newVendorsAdded: 0,
          orderGenerated: 0,
          salesInvoiced: 0,
          collection: 0,
        };
        const target = targetMap.get(key) || {
          segmentName: "",
          vendorVisitTarget: 0,
          newVendorTarget: 0,
          salesTarget: 0,
          collectionTarget: 0,
        };

        const segmentName = actual.segmentName || target.segmentName || toTitleCase(key) || "Unassigned";
        const salesActual = Number(actual.salesInvoiced || 0);
        const collectionActual = Number(actual.collection || 0);
        const visitPending = Math.max(Number(target.vendorVisitTarget || 0) - Number(actual.vendorsVisited || 0), 0);
        const vendorPending = Math.max(Number(target.newVendorTarget || 0) - Number(actual.newVendorsAdded || 0), 0);
        const salesPending = Math.max(Number(target.salesTarget || 0) - salesActual, 0);
        const collectionPending = Math.max(Number(target.collectionTarget || 0) - collectionActual, 0);

        return {
          segmentKey: key,
          segmentName,
          actual: {
            vendorsVisited: Number(actual.vendorsVisited || 0),
            newVendorsAdded: Number(actual.newVendorsAdded || 0),
            orderGenerated: Number(actual.orderGenerated || 0),
            salesInvoiced: salesActual,
            sales: salesActual,
            collection: collectionActual,
          },
          target: {
            vendorVisitTarget: Number(target.vendorVisitTarget || 0),
            newVendorTarget: Number(target.newVendorTarget || 0),
            salesTarget: Number(target.salesTarget || 0),
            collectionTarget: Number(target.collectionTarget || 0),
          },
          pending: {
            vendorVisitPending: visitPending,
            newVendorPending: vendorPending,
            salesPending,
            collectionPending,
          },
          pendingPct: {
            vendorVisitPendingPct: Number(target.vendorVisitTarget || 0) ? Math.round((visitPending / Number(target.vendorVisitTarget || 0)) * 100) : 0,
            newVendorPendingPct: Number(target.newVendorTarget || 0) ? Math.round((vendorPending / Number(target.newVendorTarget || 0)) * 100) : 0,
            salesPendingPct: Number(target.salesTarget || 0) ? Math.round((salesPending / Number(target.salesTarget || 0)) * 100) : 0,
            collectionPendingPct: Number(target.collectionTarget || 0) ? Math.round((collectionPending / Number(target.collectionTarget || 0)) * 100) : 0,
          },
        };
      });

    const summary = items.reduce(
      (acc, item) => {
        acc.vendorsVisited += Number(item.actual.vendorsVisited || 0);
        acc.newVendorsAdded += Number(item.actual.newVendorsAdded || 0);
        acc.orderGenerated += Number(item.actual.orderGenerated || 0);
        acc.salesInvoiced += Number(item.actual.salesInvoiced || 0);
        acc.collection += Number(item.actual.collection || 0);
        acc.vendorVisitTarget += Number(item.target.vendorVisitTarget || 0);
        acc.newVendorTarget += Number(item.target.newVendorTarget || 0);
        acc.salesTarget += Number(item.target.salesTarget || 0);
        acc.collectionTarget += Number(item.target.collectionTarget || 0);
        return acc;
      },
      {
        vendorsVisited: 0,
        newVendorsAdded: 0,
        orderGenerated: 0,
        salesInvoiced: 0,
        collection: 0,
        vendorVisitTarget: 0,
        newVendorTarget: 0,
        salesTarget: 0,
        collectionTarget: 0,
      }
    );

    return res.json({
      periodType,
      periodKey,
      items,
      summary,
    });
  } catch (err) {
    console.error("performance/me/segments error:", err);
    return res.status(500).json({ message: err.message || "Server error" });
  }
});




module.exports = router;
