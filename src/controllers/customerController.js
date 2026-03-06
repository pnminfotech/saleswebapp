const Customer = require("../models/Customer");

exports.searchCustomers = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 20), 50);

    const filter = { isActive: true };
    if (q) {
      filter.name = { $regex: q, $options: "i" };
    }

    const list = await Customer.find(filter)
      .sort({ name: 1 })
      .limit(limit)
      .select("name area segment");

    res.json(list);
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to search customers" });
  }
};

// Optional: allow admin to create customers OR auto-create on "New"
exports.createCustomer = async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const area = String(req.body.area || "").trim();
    const segment = String(req.body.segment || "").trim();

    if (!name) return res.status(400).json({ message: "Customer name is required" });

    // avoid duplicates (soft)
    const exists = await Customer.findOne({ name: { $regex: `^${name}$`, $options: "i" } });
    if (exists) return res.status(409).json({ message: "Customer already exists" });

    const doc = await Customer.create({
      name,
      area,
      segment,
      createdBy: req.user?.id,
    });

    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message || "Failed to create customer" });
  }
};
