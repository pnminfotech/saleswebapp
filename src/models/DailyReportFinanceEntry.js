const mongoose = require("mongoose");

const dailyReportFinanceEntrySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reportDateKey: { type: String, required: true }, // YYYY-MM-DD
    dailyReportId: { type: mongoose.Schema.Types.ObjectId, ref: "DailyCustomerReport", required: true },
    rowId: { type: mongoose.Schema.Types.ObjectId, required: true },
    customerName: { type: String, required: true, trim: true },
    type: { type: String, enum: ["INVOICE", "COLLECTION"], required: true },
    amount: { type: Number, required: true, min: 0 },
    entryDate: { type: String, required: true, trim: true }, // YYYY-MM-DD
    note: { type: String, trim: true, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

dailyReportFinanceEntrySchema.index({ userId: 1, reportDateKey: 1 });
dailyReportFinanceEntrySchema.index({ dailyReportId: 1, rowId: 1, type: 1 });

module.exports = mongoose.model("DailyReportFinanceEntry", dailyReportFinanceEntrySchema);
