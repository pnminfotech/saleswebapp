// controllers/reportController.js
const mongoose = require("mongoose");

const DailyCustomerReport = require("../models/DailyCustomerReport");
const Target = require("../models/Target");
const User = require("../models/User");
const { getRange } = require("../utils/period");

exports.adminPerformanceReport = async (req, res) => {
  try {
    const { periodType = "MONTH", periodKey } = req.query;
    if (!periodKey) return res.status(400).json({ message: "periodKey required" });

    const { from, to } = getRange(periodType, periodKey);

    // 1) aggregate actuals from daily reports
    const actualAgg = await DailyCustomerReport.aggregate([
      { $match: { reportDateKey: { $gte: from, $lte: to } } },
      {
        $project: {
          userId: 1,
          km: { $subtract: ["$closingKm", "$openingKm"] },
          rows: 1
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
          sales: {
            $sum: {
              $map: { input: { $ifNull: ["$rows", []] }, as: "r", in: { $ifNull: ["$$r.orderGenerated", 0] } }
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
          sales: { $sum: "$sales" },
          collection: { $sum: "$collection" },
        }
      }
    ]);

    // 2) load targets for those users for same period
    const userIds = actualAgg.map(x => x._id);
    const targets = await Target.find({
      userId: { $in: userIds },
      periodType,
      periodKey
    }).lean();

    const targetMap = new Map(targets.map(t => [String(t.userId), t]));

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
      const pendingSales = (t.salesTarget || 0) - a.sales;
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
        }
      };
    });

    res.json({ periodType, periodKey, from, to, items });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to generate report" });
  }
};
exports.adminCustomerWiseReport = async (req, res) => {
  try {
    const { userId, periodType = "MONTH", periodKey } = req.query;

    if (!userId) return res.status(400).json({ message: "userId required" });
    if (!periodKey) return res.status(400).json({ message: "periodKey required" });

    const { from, to } = getRange(periodType, periodKey);

    const list = await DailyCustomerReport.aggregate([
      {
        $match: {
          userId: new mongoose.Types.ObjectId(userId),
          reportDateKey: { $gte: from, $lte: to },
        },
      },
      { $unwind: "$rows" },
      {
        $group: {
          _id: "$rows.customerName", // later we can use customerId
          area: { $first: "$rows.area" },
          segment: { $first: "$rows.segment" },
          sales: { $sum: { $ifNull: ["$rows.orderGenerated", 0] } },
          collection: { $sum: { $ifNull: ["$rows.poReceived", 0] } },
          visits: { $sum: 1 },
        },
      },
      { $sort: { sales: -1 } },
    ]);

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
      .select("userId openingKm closingKm rows")
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
          sales: 0,
          modeCounts: {},
        });
      }

      const agg = byUser.get(uid);
      const opening = Number(d.openingKm || 0);
      const closing = Number(d.closingKm || 0);
      agg.runningKm += Math.max(closing - opening, 0);

      const rows = Array.isArray(d.rows) ? d.rows : [];
      for (const r of rows) {
        agg.enquiryReceived += 1;

        const order = Number(r?.orderGenerated || 0);
        const collection = Number(r?.poReceived || 0);
        agg.sales += order;
        // Count conversion when either order or collection is recorded.
        if (order > 0 || collection > 0) agg.enquiryConverted += 1;

        const mode = String(r?.enquiryMode || "").trim();
        if (mode) {
          agg.modeCounts[mode] = (agg.modeCounts[mode] || 0) + 1;
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
        const conversionRatio = x.enquiryReceived
          ? Math.round((x.enquiryConverted / x.enquiryReceived) * 100)
          : 0;

        return {
          userId: x.userId,
          name: u.name || "-",
          email: u.email || "-",
          runningKm: x.runningKm,
          enquiryReceived: x.enquiryReceived,
          modeOfEnquiry: pickTopMode(x.modeCounts),
          enquiryConverted: x.enquiryConverted,
          sales: x.sales,
          conversionRatio,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const totals = items.reduce(
      (acc, x) => {
        acc.runningKm += Number(x.runningKm || 0);
        acc.enquiryReceived += Number(x.enquiryReceived || 0);
        acc.enquiryConverted += Number(x.enquiryConverted || 0);
        acc.sales += Number(x.sales || 0);
        return acc;
      },
      { runningKm: 0, enquiryReceived: 0, enquiryConverted: 0, sales: 0 }
    );

    const consolidatedConversionRatio = totals.enquiryReceived
      ? Math.round((totals.enquiryConverted / totals.enquiryReceived) * 100)
      : 0;

    const averageSalesPerVendor = totals.enquiryConverted
      ? Math.round(totals.sales / totals.enquiryConverted)
      : 0;

    return res.json({
      periodType,
      periodKey,
      from,
      to,
      items,
      summary: {
        ...totals,
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
          sales: { $ifNull: ["$rows.orderGenerated", 0] },
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
          sales: { $sum: "$sales" },
          collection: { $sum: "$collection" }
        }
      },
      {
        $addFields: {
          pendingCollection: {
            $cond: [
              { $gt: [{ $subtract: ["$sales", "$collection"] }, 0] },
              { $subtract: ["$sales", "$collection"] },
              0
            ]
          }
        }
      },
      { $sort: { pendingCollection: -1, sales: -1, customerName: 1 } },
      {
        $project: {
          _id: 0,
          customerName: 1,
          area: 1,
          visits: 1,
          sales: 1,
          collection: 1,
          pendingCollection: 1
        }
      }
    ]);

    const summary = items.reduce(
      (acc, x) => {
        acc.sales += Number(x.sales || 0);
        acc.collection += Number(x.collection || 0);
        acc.pendingCollection += Number(x.pendingCollection || 0);
        acc.clients += 1;
        return acc;
      },
      { sales: 0, collection: 0, pendingCollection: 0, clients: 0 }
    );

    return res.json({ periodType, periodKey, from, to, items, summary });
  } catch (e) {
    return res.status(500).json({ message: e.message || "Failed to load customer tracker" });
  }
};
