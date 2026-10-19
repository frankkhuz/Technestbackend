const express = require("express");
const { Gadget } = require("../models/Gadget");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const router = express.Router();

/**
 * @swagger
 * /api/gadgets:
 *   get:
 *     summary: Search and list gadgets
 *     tags: [Gadgets]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200:
 *         description: Gadgets fetched
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.get("/", async (req, res, next) => {
  try {
    const { q, category, minPrice, maxPrice } = req.query;

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

    sendSuccess(res, 200, "Gadgets fetched", {
      gadgets,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/gadgets/{id}:
 *   get:
 *     summary: Get a single gadget by ID
 *     tags: [Gadgets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Gadget fetched
 *       404:
 *         description: Gadget not found
 */
router.get("/:id", async (req, res, next) => {
  try {
    const gadget = await Gadget.findById(req.params.id);
    if (!gadget) return sendError(res, 404, "Gadget not found");
    sendSuccess(res, 200, "Gadget fetched", { gadget });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/gadgets:
 *   post:
 *     summary: Create a new gadget entry
 *     tags: [Gadgets]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, brand, currentPrice]
 *             properties:
 *               name: { type: string }
 *               brand: { type: string }
 *               category:
 *                 type: string
 *                 enum: [smartphone, laptop, tablet, wearable, accessory, other]
 *               currentPrice: { type: number }
 *               currency: { type: string }
 *               specs: { type: object }
 *               imageUrl: { type: string }
 *               tags: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: Gadget created
 *       400:
 *         description: Missing required fields
 */
router.post("/", protect, restrictTo("admin"), verifyCsrfToken, async (req, res, next) => {
  try {
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
      return sendError(res, 400, "name, brand, and currentPrice are required");

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

    sendSuccess(res, 201, "Gadget created", { gadget });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
