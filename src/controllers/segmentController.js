const Segment = require("../models/Segment");

async function createSegment(req, res) {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ message: "Name is required" });

    const segment = new Segment({ name, description });
    await segment.save();
    res.status(201).json(segment);
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: "Segment name already exists" });
    res.status(500).json({ message: e.message });
  }
}

async function listSegments(req, res) {
  try {
    const segments = await Segment.find().sort({ name: 1 });
    res.json(segments);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

async function updateSegment(req, res) {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ message: "Name is required" });

    const segment = await Segment.findByIdAndUpdate(id, { name, description }, { new: true });
    if (!segment) return res.status(404).json({ message: "Segment not found" });
    res.json(segment);
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: "Segment name already exists" });
    res.status(500).json({ message: e.message });
  }
}

async function deleteSegment(req, res) {
  try {
    const { id } = req.params;
    const segment = await Segment.findByIdAndDelete(id);
    if (!segment) return res.status(404).json({ message: "Segment not found" });
    res.json({ message: "Segment deleted" });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = {
  createSegment,
  listSegments,
  updateSegment,
  deleteSegment,
};