const mongoose = require("mongoose");

const passwordResetRequestSchema = new mongoose.Schema(
  {
    salesUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["PENDING", "RESOLVED"], default: "PENDING" },
    note: { type: String, default: "" },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

passwordResetRequestSchema.index({ salesUserId: 1, status: 1 });

module.exports = mongoose.model("PasswordResetRequest", passwordResetRequestSchema);
