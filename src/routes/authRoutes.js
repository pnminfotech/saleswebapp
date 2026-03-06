const router = require("express").Router();
const {
  login,
  forceChangePassword,
  forgotPassword
} = require("../controllers/authController");
const { auth } = require("../middleware/auth");

router.post("/login", login);
router.post("/force-change-password", auth, forceChangePassword);
router.post("/forgot-password", forgotPassword);

module.exports = router;
