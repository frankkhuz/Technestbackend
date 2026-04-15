const express = require("express");
const { Gadget } = require("../models/Gadget");
const { protect } = require("../middleware/auth");
const router = express.Router();

// GET /api/prices/:gadgetId  —  full price history (public)
router.get("/:gadgetId", async (req, res, next) => {
  try {
    const gadget = await Gadget.findById(req.params.gadgetId).select(
      "name brand currentPrice currency priceHistory"
    );
    if (!gadget) return res.status(404).json({ error: "Gadget not found" });
    res.json(gadget);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/prices/:gadgetId  —  update current price (protected)
router.patch("/:gadgetId", protect, async (req, res, next) => {
  try {
    const { price } = req.body;

    if (!price || isNaN(price) || Number(price) <= 0)
      return res.status(400).json({ error: "A valid price is required" });

    const gadget = await Gadget.findById(req.params.gadgetId);
    if (!gadget) return res.status(404).json({ error: "Gadget not found" });

    // Archive the old price before updating
    gadget.priceHistory.push({
      price: gadget.currentPrice,
      recordedAt: new Date(),
    });
    gadget.currentPrice = Number(price);
    await gadget.save();

    res.json({ message: "Price updated", currentPrice: gadget.currentPrice });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
