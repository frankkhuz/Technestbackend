const express = require("express");
const { Device, Gadget } = require("../models/Gadget");
const { protect } = require("../middleware/auth");
const router = express.Router();

// Depreciation rates by condition
const DEPRECIATION = {
  new: 0,
  "like-new": 0.05,
  good: 0.15,
  fair: 0.3,
  poor: 0.5,
};

// GET /api/devices  —  get all devices for logged-in user
router.get("/", protect, async (req, res, next) => {
  try {
    const devices = await Device.find({ owner: req.user._id }).populate(
      "gadget",
      "name brand currentPrice imageUrl category"
    );
    res.json(devices);
  } catch (err) {
    next(err);
  }
});

// POST /api/devices  —  register a new device
router.post("/", protect, async (req, res, next) => {
  try {
    const {
      gadgetId,
      purchasePrice,
      purchaseDate,
      condition = "good",
      notes,
    } = req.body;
    if (!gadgetId)
      return res.status(400).json({ error: "gadgetId is required" });

    const gadget = await Gadget.findById(gadgetId);
    if (!gadget) return res.status(404).json({ error: "Gadget not found" });

    // Calculate estimated current value based on age + condition
    const yearsOwned = purchaseDate
      ? (Date.now() - new Date(purchaseDate)) / (1000 * 60 * 60 * 24 * 365)
      : 0;
    const depRate = DEPRECIATION[condition] ?? 0.15;
    const estimatedValue = Math.max(
      Math.round(gadget.currentPrice * (1 - depRate - yearsOwned * 0.1)),
      0
    );

    const device = await Device.create({
      owner: req.user._id,
      gadget: gadgetId,
      purchasePrice,
      purchaseDate,
      condition,
      estimatedValue,
      notes,
    });

    await device.populate("gadget", "name brand currentPrice imageUrl");
    res.status(201).json(device);
  } catch (err) {
    next(err);
  }
});

// GET /api/devices/:id  —  single device detail
router.get("/:id", protect, async (req, res, next) => {
  try {
    const device = await Device.findOne({
      _id: req.params.id,
      owner: req.user._id,
    }).populate("gadget");
    if (!device) return res.status(404).json({ error: "Device not found" });
    res.json(device);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/devices/:id  —  remove a device
router.delete("/:id", protect, async (req, res, next) => {
  try {
    const device = await Device.findOneAndDelete({
      _id: req.params.id,
      owner: req.user._id,
    });
    if (!device) return res.status(404).json({ error: "Device not found" });
    res.json({ message: "Device removed" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
