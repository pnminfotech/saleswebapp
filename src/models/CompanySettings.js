const mongoose = require("mongoose");

const CompanySettingsSchema = new mongoose.Schema(
  {
    yearType: { type: String, enum: ["FY", "CAL"], default: "FY" }, // FY=Apr–Mar, CAL=Jan–Dec
    fyStartMonth: { type: Number, default: 4, min: 1, max: 12 },   // 4 = April
  },
  { timestamps: true }
);

module.exports = mongoose.model("CompanySettings", CompanySettingsSchema);
