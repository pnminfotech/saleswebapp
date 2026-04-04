const router = require("express").Router();
const { auth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { listSegments } = require("../controllers/segmentController");

router.get("/", auth, requireRole("admin", "sales"), listSegments);

module.exports = router;
