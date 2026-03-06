const express = require("express");
const router = express.Router();

const authModule = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");

// ✅ Support both export styles of auth middleware
const auth = typeof authModule === "function" ? authModule : authModule.auth;

const {
  upsertMyDailyReport,
  getMyDailyReportByDate,
  listMyDailyReports,
  adminListDailyReports,adminListDailyReportsRange,adminExportDailyReportsCSV
} = require("../controllers/dailyCustomerReportController");

// Salesperson
router.post("/me", auth, requireRole("sales"), upsertMyDailyReport);
router.get("/me", auth, requireRole("sales"), getMyDailyReportByDate);
router.get("/me/list", auth, requireRole("sales"), listMyDailyReports);

// Admin view
// router.get("/admin", auth, requireRole("admin"), adminListDailyReports);
// Admin view (view-only)
router.get("/admin", auth, requireRole("admin"), adminListDailyReports);

// ✅ NEW: Admin list with filters (range)
router.get("/admin/list", auth, requireRole("admin"), adminListDailyReportsRange);

// ✅ NEW: Admin export CSV
router.get("/admin/export.csv", auth, requireRole("admin"), adminExportDailyReportsCSV);

module.exports = router;
