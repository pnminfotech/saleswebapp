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
const Target = require("../models/Target");
const authModule = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const reportController = require("../controllers/reportController");

const auth = typeof authModule === "function" ? authModule : authModule.auth;

// Admin reports
router.get("/performance", auth, requireRole("admin"), reportController.adminPerformanceReport);
router.get("/customerwise", auth, requireRole("admin"), reportController.adminCustomerWiseReport);
router.get("/lead-conversion", auth, requireRole("admin"), reportController.adminLeadConversionReport);
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
  const fy = raw.match(/^FY(\d{4})-Q([1-4])$/);

  if (fy) {
    const fyStart = Number(fy[1]);
    const q = Number(fy[2]);
    if (q === 1) return { startKey: `${fyStart}-04-01`, endKey: `${fyStart}-07-01` };
    if (q === 2) return { startKey: `${fyStart}-07-01`, endKey: `${fyStart}-10-01` };
    if (q === 3) return { startKey: `${fyStart}-10-01`, endKey: `${fyStart + 1}-01-01` };
    return { startKey: `${fyStart + 1}-01-01`, endKey: `${fyStart + 1}-04-01` };
  }

  // backward compatibility: "2026-Q1"
  const [yStr, qStr] = raw.split("-");
  const y = Number(yStr);
  const q = Number(String(qStr || "").replace("Q", ""));
  const startMonth = (q - 1) * 3 + 1;
  const startKey = `${y}-${String(startMonth).padStart(2, "0")}-01`;
  const endMonth = startMonth + 3;
  const endY = endMonth > 12 ? y + 1 : y;
  const endM = endMonth > 12 ? endMonth - 12 : endMonth;
  const endKey = `${endY}-${String(endM).padStart(2, "0")}-01`;
  return { startKey, endKey };
}

function yearRange(yKey) {
  const raw = String(yKey || "").toUpperCase().trim();

  // FY2026 => Apr 1, 2026 to Apr 1, 2027
  const fy = raw.match(/^FY(\d{4})$/);
  if (fy) {
    const y = Number(fy[1]);
    return { startKey: `${y}-04-01`, endKey: `${y + 1}-04-01` };
  }

  // CY2026 or 2026 => Jan 1, 2026 to Jan 1, 2027
  const cy = raw.match(/^CY(\d{4})$/);
  const y = Number(cy ? cy[1] : raw);
  return { startKey: `${y}-01-01`, endKey: `${y + 1}-01-01` };
}

function periodToRange(periodType, periodKey) {
  if (periodType === "MONTH") return monthRange(periodKey);
  if (periodType === "QUARTER") return quarterRange(periodKey);
  return yearRange(periodKey);
}

router.get("/performance/me", auth, async (req, res) => {
  try {
    const { periodType, periodKey } = req.query;
    if (!periodType || !periodKey) {
      return res.status(400).json({ message: "periodType and periodKey are required" });
    }

    const userId = req.user.id;
    const userObjId = new mongoose.Types.ObjectId(userId);

    // 1) target from Target collection (this part is correct)
    const target = await Target.findOne({ userId, periodType, periodKey }).lean();

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
          sales: {
            $sum: {
              $map: {
                input: { $ifNull: ["$rows", []] },
                as: "r",
                in: { $ifNull: ["$$r.orderGenerated", 0] }, // your UI shows "Order Generated"
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
          sales: { $sum: "$sales" },
          collection: { $sum: "$collection" },
          poReceived: { $sum: "$poReceived" },
        },
      },
    ]);

    const actual = agg?.[0] || {
      runningKm: 0,
      vendorsVisited: 0,
      newVendorsAdded: 0,
      sales: 0,
      collection: 0,
      poReceived: 0,
    };

    return res.json({ target: target || null, actual });
  } catch (err) {
    console.error("performance/me error:", err);
    res.status(500).json({ message: err.message || "Server error" });
  }
});




module.exports = router;
