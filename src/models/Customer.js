const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    area: { type: String, trim: true, default: "" },
    segment: { type: String, trim: true, default: "" },

    // optional tracking
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // salesperson
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Fast search
customerSchema.index({ name: 1 });
customerSchema.index({ area: 1 });

module.exports = mongoose.model("Customer", customerSchema);
