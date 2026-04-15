const express = require("express");
const { Gadget } = require("../models/Gadget");
const { protect } = require("../middleware/auth");
const router = express.Router();

// GET /api/gadgets?q=iphone&category=smartphone&minPrice=50000&maxPrice=200000
router.get("/", async (req, res, next) => {
  try {
    const { q, category, minPrice, maxPrice } = req.query;

    // Sanitize pagination — cap limit at 50, prevent negative pages
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));

    const filter = {};

    if (q) filter.$text = { $search: q };
    if (category) filter.category = category;
    if (minPrice || maxPrice) {
      filter.currentPrice = {};
      if (minPrice) filter.currentPrice.$gte = Number(minPrice);
      if (maxPrice) filter.currentPrice.$lte = Number(maxPrice);
    }

    const gadgets = await Gadget.find(filter)
      .skip((page - 1) * limit)
      .limit(limit)
      .sort({ createdAt: -1 });

    const total = await Gadget.countDocuments(filter);

    res.json({
      gadgets,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/gadgets/:id
router.get("/:id", async (req, res, next) => {
  try {
    const gadget = await Gadget.findById(req.params.id);
    if (!gadget) return res.status(404).json({ error: "Gadget not found" });
    res.json(gadget);
  } catch (err) {
    next(err);
  }
});

// POST /api/gadgets  (protected — admin only in future)
router.post("/", protect, async (req, res, next) => {
  try {
    // Whitelist only allowed fields — never pass raw req.body to DB
    const {
      name,
      brand,
      category,
      currentPrice,
      currency,
      specs,
      imageUrl,
      tags,
    } = req.body;

    if (!name || !brand || !currentPrice)
      return res
        .status(400)
        .json({ error: "name, brand, and currentPrice are required" });

    const gadget = await Gadget.create({
      name,
      brand,
      category,
      currentPrice,
      currency,
      specs,
      imageUrl,
      tags,
    });

    res.status(201).json(gadget);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
