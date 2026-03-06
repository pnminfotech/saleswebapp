const User = require("../models/User");
const PasswordResetRequest = require("../models/PasswordResetRequest");
const { comparePassword, hashPassword } = require("../utils/hash");
const { signJwt } = require("../utils/token");
const {
  loginSchema,
  forceChangeSchema,
  forgotPasswordSchema
} = require("../utils/validators");

async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const { userId, password } = parsed.data;
  const key = String(userId || "").trim().toLowerCase();
  const user = await User.findOne({
    $or: [{ userId: key }, { email: key }]
  });

  if (!user || !user.active) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await comparePassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  const token = signJwt({ id: user._id, role: user.role });

  res.json({
    token,
    user: {
      id: user._id,
      name: user.name,
      userId: user.userId,
      email: user.email,
      role: user.role,
      mustResetPassword: user.mustResetPassword
    }
  });
}

async function forceChangePassword(req, res) {
  const parsed = forceChangeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ message: "User not found" });

  user.passwordHash = await hashPassword(parsed.data.newPassword);
  user.mustResetPassword = false;
  await user.save();

  res.json({ ok: true });
}

async function forgotPassword(req, res) {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const userId = String(parsed.data.userId || "").trim().toLowerCase();
  const user = await User.findOne({ userId, role: "sales", active: true });

  if (user) {
    const openRequest = await PasswordResetRequest.findOne({
      salesUserId: user._id,
      status: "PENDING"
    });
    if (!openRequest) {
      await PasswordResetRequest.create({
        salesUserId: user._id,
        status: "PENDING",
        note: String(parsed.data.note || "").trim()
      });
    }
  }

  res.json({
    ok: true,
    message: "Request submitted. Please contact admin for password reset."
  });
}

module.exports = { login, forceChangePassword, forgotPassword };
