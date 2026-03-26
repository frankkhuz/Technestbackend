const express = require("express");
const { Gadget } = require("../models/Gadget");
const router = express.Router();

// GET /api/gadgets?q=iphone&category=smartphone&minPrice=50000&maxPrice=200000
router.get("/", async (req, res, next) => {
  try {
    const { q, category, minPrice, maxPrice, page = 1, limit = 10 } = req.query;
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
      .limit(Number(limit))
      .sort({ createdAt: -1 });

    const total = await Gadget.countDocuments(filter);

    res.json({
      gadgets,
      total,
      page: Number(page),
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

// POST /api/gadgets  (admin: add a gadget)
router.post("/", async (req, res, next) => {
  try {
    const gadget = await Gadget.create(req.body);
    res.status(201).json(gadget);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
