const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const {
  deleteTargetSheetImportByYear,
  getTargetSheetImportByYear,
  listTargetSheetImports,
  upsertTargetSheetImport,
} = require("../controllers/targetSheetImportController");

router.use(auth, requireRole("admin"));

router.get("/", listTargetSheetImports);
router.get("/:yearKey", getTargetSheetImportByYear);
router.delete("/:yearKey", deleteTargetSheetImportByYear);
router.post("/", upsertTargetSheetImport);

module.exports = router;
