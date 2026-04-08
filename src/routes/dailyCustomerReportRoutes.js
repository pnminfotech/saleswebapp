const express = require("express");
const router = express.Router();

const authModule = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");

// Support both export styles of auth middleware
const auth = typeof authModule === "function" ? authModule : authModule.auth;

const {
  upsertMyDailyReport,
  getMyDailyReportByDate,
  listMyDailyReports,
  getMyCustomerVisitTemplate,
  adminUpdateDailyReport,
  adminListFinanceEntries,
  adminAddFinanceEntry,
  adminDeleteFinanceEntry,
  adminUpdateNewCustomerLastDate,
  adminListDailyReports,
  adminListDailyReportsRange,
  adminExportDailyReportsCSV,
} = require("../controllers/dailyCustomerReportController");

// Salesperson
router.post("/me", auth, requireRole("sales"), upsertMyDailyReport);
router.get("/me", auth, requireRole("sales"), getMyDailyReportByDate);
router.get("/me/list", auth, requireRole("sales"), listMyDailyReports);
router.get("/me/customer-template", auth, requireRole("sales"), getMyCustomerVisitTemplate);

// Admin view
router.get("/admin", auth, requireRole("admin"), adminListDailyReports);
router.get("/admin/list", auth, requireRole("admin"), adminListDailyReportsRange);
router.get("/admin/export.csv", auth, requireRole("admin"), adminExportDailyReportsCSV);
router.post("/admin/update", auth, requireRole("admin"), adminUpdateDailyReport);
router.get("/admin/finance-entries", auth, requireRole("admin"), adminListFinanceEntries);
router.post("/admin/finance-entries", auth, requireRole("admin"), adminAddFinanceEntry);
router.delete("/admin/finance-entries/:id", auth, requireRole("admin"), adminDeleteFinanceEntry);
router.post("/admin/new-tracking/last-date", auth, requireRole("admin"), adminUpdateNewCustomerLastDate);

module.exports = router;
