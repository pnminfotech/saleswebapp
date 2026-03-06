const mongoose = require("mongoose");

const rowSchema = new mongoose.Schema(
  {
    customerName: { type: String, required: true, trim: true },
    newOrExisting: { type: String, enum: ["New", "Existing"], default: "Existing" },
    area: { type: String, trim: true },
    metTo: { type: String, trim: true }, // Mr/Mrs/Miss
    designation: { type: String, trim: true },
    enquiryMode: { type: String, trim: true },
    orderGenerated: { type: Number, default: 0 }, // ₹
    segment: { type: String, trim: true },
    poReceived: { type: Number, default: 0 }, // ₹
  },
  { _id: true }
);

const dailyCustomerReportSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Store a simple key so we don't mess with timezone
    reportDateKey: { type: String, required: true }, // "YYYY-MM-DD"

    openingKm: { type: Number, default: 0 },
    closingKm: { type: Number, default: 0 },
    startLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      accuracy: { type: Number, default: null },
      capturedAt: { type: Date, default: null }
    },
    locationTrail: {
      type: [
        {
          lat: { type: Number, required: true },
          lng: { type: Number, required: true },
          accuracy: { type: Number, default: null },
          capturedAt: { type: Date, required: true }
        }
      ],
      default: []
    },

    rows: { type: [rowSchema], default: [] },

    
  },
  { timestamps: true }
);

// prevent duplicate report for same date + salesperson
dailyCustomerReportSchema.index({ userId: 1, reportDateKey: 1 }, { unique: true });

module.exports = mongoose.model("DailyCustomerReport", dailyCustomerReportSchema);
