const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const {
  upsertTarget,
  getMyTarget,
  getTargetSummary,
  getOneTargetForAdmin,
  listTargetsForAdmin,
  deleteTarget,
  upsertAnnualAndGenerate,
} = require("../controllers/targetController");

router.post("/", auth, requireRole("admin"), upsertTarget);
router.get("/me", auth, requireRole("admin", "sales"), getMyTarget);
router.get("/summary", auth, requireRole("admin"), getTargetSummary);
router.get("/one", auth, requireRole("admin"), getOneTargetForAdmin);
router.get("/admin-list", auth, requireRole("admin"), listTargetsForAdmin);
router.delete("/:id", auth, requireRole("admin"), deleteTarget);
router.post("/annual", auth, requireRole("admin"), upsertAnnualAndGenerate);

module.exports = router;
