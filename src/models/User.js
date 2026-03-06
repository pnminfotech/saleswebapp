const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    userId: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, default: "" },
    role: { type: String, enum: ["admin", "sales"], required: true },
    passwordHash: { type: String, required: true },
    mustResetPassword: { type: Boolean, default: true },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
