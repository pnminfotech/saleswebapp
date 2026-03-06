const CompanySettings = require("../models/CompanySettings");

async function getCompanySettings(req, res) {
  let s = await CompanySettings.findOne();
  if (!s) s = await CompanySettings.create({ yearType: "FY", fyStartMonth: 4 });
  res.json(s);
}

async function updateCompanySettings(req, res) {
  const { yearType, fyStartMonth } = req.body || {};

  const patch = {};
  if (yearType === "FY" || yearType === "CAL") patch.yearType = yearType;

  if (typeof fyStartMonth !== "undefined") {
    const n = Number(fyStartMonth);
    if (!Number.isFinite(n) || n < 1 || n > 12) {
      return res.status(400).json({ message: "fyStartMonth must be 1..12" });
    }
    patch.fyStartMonth = n;
  }

  let s = await CompanySettings.findOne();
  if (!s) s = await CompanySettings.create({ yearType: "FY", fyStartMonth: 4 });

  s = await CompanySettings.findByIdAndUpdate(s._id, { $set: patch }, { new: true });
  res.json(s);
}

module.exports = { getCompanySettings, updateCompanySettings };
