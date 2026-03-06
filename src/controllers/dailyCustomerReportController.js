const DailyCustomerReport = require("../models/DailyCustomerReport");
const Customer = require("../models/Customer");

const User = require("../models/User"); // if you want join info (optional)

function isValidDateKey(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

exports.upsertMyDailyReport = async (req, res) => {
  try {
    const userId = req.user.id;
    const { reportDateKey, openingKm, closingKm, rows, startLocation, locationTrail } = req.body;

    if (!isValidDateKey(reportDateKey)) {
      return res.status(400).json({ message: "reportDateKey must be YYYY-MM-DD" });
    }

    const open = Number(openingKm || 0);
    const close = Number(closingKm || 0);

    if (open < 0 || close < 0) {
      return res.status(400).json({ message: "KM cannot be negative" });
    }
    if (close < open) {
      return res.status(400).json({ message: "Closing KM cannot be less than Opening KM" });
    }

    const safeRows = Array.isArray(rows) ? rows : [];
    // minimal cleanup
    const cleanedRows = safeRows.map((r) => ({
      customerName: String(r.customerName || "").trim(),
      newOrExisting: r.newOrExisting === "New" ? "New" : "Existing",
      area: String(r.area || "").trim(),
      metTo: String(r.metTo || "").trim(),
      designation: String(r.designation || "").trim(),
      enquiryMode: String(r.enquiryMode || "").trim(),
      orderGenerated: Number(r.orderGenerated || 0),
      segment: String(r.segment || "").trim(),
      poReceived: Number(r.poReceived || 0),
    })).filter(r => r.customerName);
// Auto-create NEW customers in master list
const newNames = cleanedRows
  .filter((r) => r.newOrExisting === "New")
  .map((r) => ({
    name: r.customerName,
    area: r.area || "",
    segment: r.segment || "",
    createdBy: userId,
    isActive: true,
  }));

for (const n of newNames) {
  // upsert by case-insensitive match
  const exists = await Customer.findOne({ name: { $regex: `^${n.name}$`, $options: "i" } });
  if (!exists) await Customer.create(n);
}

    let cleanStartLocation = null;
    if (startLocation && Number.isFinite(Number(startLocation.lat)) && Number.isFinite(Number(startLocation.lng))) {
      const lat = Number(startLocation.lat);
      const lng = Number(startLocation.lng);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        cleanStartLocation = {
          lat,
          lng,
          accuracy: Number.isFinite(Number(startLocation.accuracy)) ? Number(startLocation.accuracy) : null,
          capturedAt: startLocation.capturedAt ? new Date(startLocation.capturedAt) : new Date()
        };
      }
    }

    let cleanLocationTrail = [];
    if (Array.isArray(locationTrail)) {
      cleanLocationTrail = locationTrail
        .map((p) => {
          const lat = Number(p?.lat);
          const lng = Number(p?.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
          if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
          return {
            lat,
            lng,
            accuracy: Number.isFinite(Number(p?.accuracy)) ? Number(p.accuracy) : null,
            capturedAt: p?.capturedAt ? new Date(p.capturedAt) : new Date()
          };
        })
        .filter(Boolean)
        .slice(-1000);
    }

    const setObj = {
      openingKm: open,
      closingKm: close,
      rows: cleanedRows,
    };

    if (cleanStartLocation) setObj.startLocation = cleanStartLocation;
    if (Array.isArray(locationTrail)) setObj.locationTrail = cleanLocationTrail;

    const doc = await DailyCustomerReport.findOneAndUpdate(
      { userId, reportDateKey },
      {
        $set: setObj,
      },
      { new: true, upsert: true }
    );

    return res.json(doc);
  } catch (e) {
    // duplicate key safe
    if (e.code === 11000) {
      return res.status(409).json({ message: "Report already exists for this date. Please refresh and edit." });
    }
    return res.status(500).json({ message: e.message });
  }
};

exports.getMyDailyReportByDate = async (req, res) => {
  try {
    const userId = req.user.id;
    const { date } = req.query; // YYYY-MM-DD

    if (!isValidDateKey(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }

    const doc = await DailyCustomerReport.findOne({ userId, reportDateKey: date });
    return res.json(doc || null);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

exports.listMyDailyReports = async (req, res) => {
  try {
    const userId = req.user.id;
    const { from, to } = req.query; // YYYY-MM-DD

    const q = { userId };
    if (from && isValidDateKey(from)) q.reportDateKey = { ...(q.reportDateKey || {}), $gte: from };
    if (to && isValidDateKey(to)) q.reportDateKey = { ...(q.reportDateKey || {}), $lte: to };

    const docs = await DailyCustomerReport.find(q).sort({ reportDateKey: -1 });
    return res.json(docs);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};

// Admin list (optional but useful)
exports.adminListDailyReports = async (req, res) => {
  try {
    const { userId, date } = req.query; // filter optional

    const q = {};
    if (userId) q.userId = userId;
    if (date && isValidDateKey(date)) q.reportDateKey = date;

    const docs = await DailyCustomerReport.find(q)
      .sort({ reportDateKey: -1 })
      .populate("userId", "name email");

    return res.json(docs);
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
};


/**
 * Admin: list daily reports in date range (view-only)
 * GET /api/reports/daily-customer/admin/list?userId=&from=&to=
 */
exports.adminListDailyReportsRange = async (req, res) => {
  try {
    const { userId, from, to } = req.query;
    const parsedLimit = Number(req.query.limit || 200);
    const maxLimit = 5000;
    const safeLimit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, maxLimit))
      : 200;
    if (from && !isValidDateKey(String(from))) {
      return res.status(400).json({ message: "Invalid 'from' date. Use YYYY-MM-DD" });
    }
    if (to && !isValidDateKey(String(to))) {
      return res.status(400).json({ message: "Invalid 'to' date. Use YYYY-MM-DD" });
    }
    if (from && to && String(from) > String(to)) {
      return res.status(400).json({ message: "'from' date cannot be after 'to' date" });
    }

    const filter = {};
    if (userId) filter.userId = userId;

    if (from || to) {
      filter.reportDateKey = {};
      if (from) filter.reportDateKey.$gte = String(from);
      if (to) filter.reportDateKey.$lte = String(to);
    }

    const list = await DailyCustomerReport.find(filter)
      .select("userId reportDateKey openingKm closingKm startLocation locationTrail rows")
      .sort({ reportDateKey: -1 })
      .limit(safeLimit)
      .populate("userId", "name email")
      .lean();

    // Totals for summary
    let totalNetKm = 0;
    let totalOrder = 0;
    let totalPO = 0;
    let totalRows = 0;

    const mapped = list.map((r) => {
      const opening = Number(r.openingKm || 0);
      const closing = Number(r.closingKm || 0);
      const netKm = closing - opening;

      const rows = Array.isArray(r.rows) ? r.rows : [];
      const orderSum = rows.reduce((a, x) => a + Number(x.orderGenerated || 0), 0);
      const poSum = rows.reduce((a, x) => a + Number(x.poReceived || 0), 0);
      const clientVisits = rows
        .map((x) => ({
          customerName: String(x?.customerName || "").trim(),
          area: String(x?.area || "").trim(),
        }))
        .filter((x) => x.customerName);

      const uniqClientMap = new Map();
      for (const c of clientVisits) {
        const k = `${c.customerName.toLowerCase()}|${c.area.toLowerCase()}`;
        if (!uniqClientMap.has(k)) uniqClientMap.set(k, c);
      }
      const uniqClientVisits = Array.from(uniqClientMap.values());

      totalNetKm += netKm;
      totalOrder += orderSum;
      totalPO += poSum;
      totalRows += rows.length;

      return {
        _id: r._id,
        userId: r.userId,
        reportDateKey: r.reportDateKey,
        openingKm: r.openingKm,
        closingKm: r.closingKm,
        startLocation: r.startLocation || null,
        locationTrail: Array.isArray(r.locationTrail)
          ? r.locationTrail.map((p) => ({
              lat: Number(p?.lat),
              lng: Number(p?.lng),
              accuracy: Number(p?.accuracy || 0),
              capturedAt: p?.capturedAt || null,
            }))
          : [],
        netKm,
        rowsCount: rows.length,
        orderSum,
        poSum,
        clientVisits: uniqClientVisits,
        // keep row-level values for combined customer analytics screens
        rows: rows.map((x) => ({
          customerName: String(x?.customerName || "").trim(),
          area: String(x?.area || "").trim(),
          orderGenerated: Number(x?.orderGenerated || 0),
          poReceived: Number(x?.poReceived || 0),
          newOrExisting: x?.newOrExisting === "New" ? "New" : "Existing",
          enquiryMode: String(x?.enquiryMode || "").trim(),
        })),
      };
    });

    res.json({
      items: mapped,
      summary: {
        count: mapped.length,
        totalRows,
        totalNetKm,
        totalOrder,
        totalPO,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to load admin reports" });
  }
};

/**
 * Admin: export CSV (view-only)
 * GET /api/reports/daily-customer/admin/export.csv?userId=&from=&to=
 */
exports.adminExportDailyReportsCSV = async (req, res) => {
  try {
    const { userId, from, to } = req.query;
    if (from && !isValidDateKey(String(from))) {
      return res.status(400).json({ message: "Invalid 'from' date. Use YYYY-MM-DD" });
    }
    if (to && !isValidDateKey(String(to))) {
      return res.status(400).json({ message: "Invalid 'to' date. Use YYYY-MM-DD" });
    }
    if (from && to && String(from) > String(to)) {
      return res.status(400).json({ message: "'from' date cannot be after 'to' date" });
    }

    const filter = {};
    if (userId) filter.userId = userId;

    if (from || to) {
      filter.reportDateKey = {};
      if (from) filter.reportDateKey.$gte = String(from);
      if (to) filter.reportDateKey.$lte = String(to);
    }

    const list = await DailyCustomerReport.find(filter)
      .select("userId reportDateKey openingKm closingKm startLocation locationTrail rows")
      .sort({ reportDateKey: -1 })
      .limit(2000)
      .lean();

    // CSV header
    const header = [
      "reportDate",
      "salespersonUserId",
      "openingKm",
      "closingKm",
      "netKm",
      "startLat",
      "startLng",
      "startAccuracy",
      "startCapturedAt",
      "trackPoints",
      "customerName",
      "newOrExisting",
      "area",
      "metTo",
      "designation",
      "orderGenerated",
      "segment",
      "poReceived",
    ];

    const rows = [header.join(",")];

    // Flatten each report rows into CSV rows
    for (const r of list) {
      const opening = Number(r.openingKm || 0);
      const closing = Number(r.closingKm || 0);
      const netKm = closing - opening;
      const startLat = Number(r?.startLocation?.lat);
      const startLng = Number(r?.startLocation?.lng);
      const startAccuracy = Number(r?.startLocation?.accuracy);
      const startCapturedAt = r?.startLocation?.capturedAt
        ? new Date(r.startLocation.capturedAt).toISOString()
        : "";
      const trackPoints = Array.isArray(r?.locationTrail) ? r.locationTrail.length : 0;
      const items = Array.isArray(r.rows) ? r.rows : [];

      if (!items.length) {
        // still output one line per report
        rows.push(
          [
            r.reportDateKey,
            r.userId,
            opening,
            closing,
            netKm,
            Number.isFinite(startLat) ? startLat : "",
            Number.isFinite(startLng) ? startLng : "",
            Number.isFinite(startAccuracy) ? startAccuracy : "",
            startCapturedAt,
            trackPoints,
            "", "", "", "", "", "", "", ""
          ].join(",")
        );
        continue;
      }

      for (const it of items) {
        const safe = (v) => {
          const s = String(v ?? "").replace(/"/g, '""');
          // wrap in quotes if contains comma
          return s.includes(",") ? `"${s}"` : s;
        };

        rows.push(
          [
            safe(r.reportDateKey),
            safe(r.userId),
            opening,
            closing,
            netKm,
            Number.isFinite(startLat) ? startLat : "",
            Number.isFinite(startLng) ? startLng : "",
            Number.isFinite(startAccuracy) ? startAccuracy : "",
            safe(startCapturedAt),
            trackPoints,
            safe(it.customerName),
            safe(it.newOrExisting),
            safe(it.area),
            safe(it.metTo),
            safe(it.designation),
            Number(it.orderGenerated || 0),
            safe(it.segment),
            Number(it.poReceived || 0),
          ].join(",")
        );
      }
    }

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=daily-reports.csv");
    res.send(rows.join("\n"));
  } catch (e) {
    res.status(500).json({ message: e.message || "Export failed" });
  }
};
