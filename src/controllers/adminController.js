const { nanoid } = require("nanoid");
const mongoose = require("mongoose");
const User = require("../models/User");
const PasswordResetRequest = require("../models/PasswordResetRequest");
const { hashPassword } = require("../utils/hash");
const { createSalesSchema, updateSalesSchema, adminResetPasswordSchema } = require("../utils/validators");

async function createSalesperson(req, res) {
  const parsed = createSalesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const { name, userId, email, phone } = parsed.data;
  const userIdLc = userId.toLowerCase();
  const emailLc = String(email || `${userIdLc}@local.salesmis`).toLowerCase();

  const existingUserId = await User.findOne({ userId: userIdLc });
  if (existingUserId) return res.status(409).json({ message: "User ID already exists" });

  const existingEmail = await User.findOne({ email: emailLc });
  if (existingEmail) return res.status(409).json({ message: "Email already exists" });

  const tempPassword = nanoid(10);
  const passwordHash = await hashPassword(tempPassword);

  const user = await User.create({
    name,
    userId: userIdLc,
    email: emailLc,
    phone: phone || "",
    role: "sales",
    passwordHash,
    mustResetPassword: true,
    active: true
  });

  res.status(201).json({
    id: user._id,
    name: user.name,
    userId: user.userId,
    email: user.email,
    tempPassword
  });
}

async function listSalespersons(req, res) {
  const users = await User.find({ role: "sales" })
    .select("-passwordHash")
    .sort({ createdAt: -1 });

  res.json(users);
}

async function updateSalesperson(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid salesperson id" });

  const parsed = updateSalesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const existing = await User.findOne({ _id: id, role: "sales" });
  if (!existing) return res.status(404).json({ message: "Salesperson not found" });

  const { name, userId, email, phone, active } = parsed.data;
  const userIdLc = userId.toLowerCase();
  const emailLc = String(email || `${userIdLc}@local.salesmis`).toLowerCase();

  const conflictUserId = await User.findOne({ userId: userIdLc, _id: { $ne: id } });
  if (conflictUserId) return res.status(409).json({ message: "User ID already exists" });

  const conflictEmail = await User.findOne({ email: emailLc, _id: { $ne: id } });
  if (conflictEmail) return res.status(409).json({ message: "Email already exists" });

  existing.name = name;
  existing.userId = userIdLc;
  existing.email = emailLc;
  existing.phone = phone || "";
  if (typeof active === "boolean") existing.active = active;

  await existing.save();

  res.json({
    id: existing._id,
    name: existing.name,
    userId: existing.userId,
    email: existing.email,
    phone: existing.phone,
    active: existing.active
  });
}

async function deleteSalesperson(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid salesperson id" });

  const deleted = await User.findOneAndDelete({ _id: id, role: "sales" });
  if (!deleted) return res.status(404).json({ message: "Salesperson not found" });

  await PasswordResetRequest.deleteMany({ salesUserId: deleted._id });

  res.json({ message: "Salesperson deleted" });
}

async function listPasswordResetRequests(req, res) {
  const items = await PasswordResetRequest.find({ status: "PENDING" })
    .populate("salesUserId", "name userId email phone active")
    .sort({ createdAt: -1 });
  res.json(items);
}

async function resolvePasswordResetRequest(req, res) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Invalid request id" });

  const parsed = adminResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const reqItem = await PasswordResetRequest.findOne({ _id: id, status: "PENDING" }).populate("salesUserId");
  if (!reqItem) return res.status(404).json({ message: "Pending reset request not found" });
  if (!reqItem.salesUserId) return res.status(404).json({ message: "Salesperson not found" });

  reqItem.salesUserId.passwordHash = await hashPassword(parsed.data.newPassword);
  reqItem.salesUserId.mustResetPassword = true;
  await reqItem.salesUserId.save();

  reqItem.status = "RESOLVED";
  reqItem.resolvedBy = req.user._id;
  reqItem.resolvedAt = new Date();
  await reqItem.save();

  res.json({ ok: true, message: "Password reset completed" });
}

module.exports = {
  createSalesperson,
  listSalespersons,
  updateSalesperson,
  deleteSalesperson,
  listPasswordResetRequests,
  resolvePasswordResetRequest
};
