const mongoose = require("mongoose");

const targetSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    salespersonName: { type: String, trim: true, default: "" },
    salespersonEmail: { type: String, trim: true, default: "" },
    segmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Segment", required: true },
    periodType: { type: String, enum: ["MONTH", "QUARTER", "YEAR"], required: true },
    periodKey: { type: String, required: true }, // 2026-02, 2026-Q1, FY2026
    periodBasis: { type: String, enum: ["FISCAL", "CALENDAR"], default: "FISCAL" },
    vendorVisitTarget: { type: Number, default: 0, min: 0 },
    newVendorTarget: { type: Number, default: 0, min: 0 },
    salesTarget: { type: Number, default: 0, min: 0 }, // Target for Sales (invoice amount)
    collectionTarget: { type: Number, default: 0, min: 0 },
    source: { type: String, enum: ["AUTO", "MANUAL"], default: "MANUAL" },
    parentKey: { type: String, default: "" }, // e.g. FY2025-26 (the annual key)

  },
  { timestamps: true }
);

targetSchema.index({ userId: 1, segmentId: 1, periodType: 1, periodKey: 1 }, { unique: true });

module.exports = mongoose.model("Target", targetSchema);
