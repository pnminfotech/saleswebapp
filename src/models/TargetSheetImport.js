const mongoose = require("mongoose");

const targetSheetImportSchema = new mongoose.Schema(
  {
    yearKey: { type: String, required: true, unique: true, trim: true },
    fileName: { type: String, required: true, trim: true },
    sheetName: { type: String, required: true, trim: true },
    salespersonNames: { type: [String], default: [] },
    segmentNames: { type: [String], default: [] },
    matrix: { type: [[mongoose.Schema.Types.Mixed]], default: [] },
    assignments: { type: [mongoose.Schema.Types.Mixed], default: [] },
    rowCount: { type: Number, default: 0 },
    columnCount: { type: Number, default: 0 },
    assignmentCount: { type: Number, default: 0 },
    appliedTargetCount: { type: Number, default: 0 },
    replacedTargetCount: { type: Number, default: 0 },
    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    importedByName: { type: String, default: "" },
    importedByEmail: { type: String, default: "" },
    importedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TargetSheetImport", targetSheetImportSchema);
