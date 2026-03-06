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

router.use(auth, requireRole("admin"));

router.post("/salespersons", createSalesperson);
router.get("/salespersons", listSalespersons);
router.put("/salespersons/:id", updateSalesperson);
router.delete("/salespersons/:id", deleteSalesperson);
router.get("/password-reset-requests", listPasswordResetRequests);
router.post("/password-reset-requests/:id/reset", resolvePasswordResetRequest);

module.exports = router;
