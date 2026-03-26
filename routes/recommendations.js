const express = require("express");
const { Gadget } = require("../models/Gadget");
const { protect } = require("../middleware/auth");
const router = express.Router();

// GET /api/recommendations?gadgetId=xxx
// Returns cheaper or similarly-priced alternatives in the same category
router.get("/", protect, async (req, res, next) => {
  try {
    const { gadgetId } = req.query;
    if (!gadgetId)
      return res.status(400).json({ error: "gadgetId is required" });

    const source = await Gadget.findById(gadgetId);
    if (!source) return res.status(404).json({ error: "Gadget not found" });

    const alternatives = await Gadget.find({
      category: source.category,
      _id: { $ne: source._id },
      currentPrice: { $lte: source.currentPrice * 1.15 }, // within 15% or cheaper
    })
      .sort({ currentPrice: 1 })
      .limit(5);

    res.json({
      source: {
        id: source._id,
        name: source.name,
        brand: source.brand,
        currentPrice: source.currentPrice,
        category: source.category,
      },
      alternatives,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
