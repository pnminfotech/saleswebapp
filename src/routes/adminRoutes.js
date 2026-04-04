const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const {
  createSalesperson,
  listSalespersons,
  updateSalesperson,
  deleteSalesperson,
  listPasswordResetRequests,
  resolvePasswordResetRequest
} = require("../controllers/adminController");
const {
  createSegment,
  listSegments,
  updateSegment,
  deleteSegment,
} = require("../controllers/segmentController");

router.use(auth, requireRole("admin"));

router.post("/salespersons", createSalesperson);
router.get("/salespersons", listSalespersons);
router.put("/salespersons/:id", updateSalesperson);
router.delete("/salespersons/:id", deleteSalesperson);
router.get("/password-reset-requests", listPasswordResetRequests);
router.post("/password-reset-requests/:id/reset", resolvePasswordResetRequest);

router.post("/segments", createSegment);
router.get("/segments", listSegments);
router.put("/segments/:id", updateSegment);
router.delete("/segments/:id", deleteSegment);

module.exports = router;
