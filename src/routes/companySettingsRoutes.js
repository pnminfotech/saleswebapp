const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { getCompanySettings, updateCompanySettings } = require("../controllers/companySettingsController");

router.get("/company", auth, requireRole("admin", "sales"), getCompanySettings);
router.put("/company", auth, requireRole("admin"), updateCompanySettings);

module.exports = router;
