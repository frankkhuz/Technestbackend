const express = require("express");
const { Device, Gadget } = require("../models/Gadget");
const { protect } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const router = express.Router();

const DEPRECIATION = {
  new: 0,
  "like-new": 0.05,
  good: 0.15,
  fair: 0.3,
  poor: 0.5,
};

/**
 * @swagger
 * /api/devices:
 *   get:
 *     summary: Get all devices owned by the logged-in user
 *     tags: [Devices]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Devices fetched
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 */
router.get("/", protect, async (req, res, next) => {
  try {
    const devices = await Device.find({ owner: req.user._id }).populate(
      "gadget",
      "name brand currentPrice imageUrl category"
    );
    sendSuccess(res, 200, "Devices fetched", { devices });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/devices:
 *   post:
 *     summary: Register a new owned device
 *     tags: [Devices]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [gadgetId]
 *             properties:
 *               gadgetId: { type: string }
 *               purchasePrice: { type: number }
 *               purchaseDate: { type: string, format: date }
 *               condition:
 *                 type: string
 *                 enum: [new, like-new, good, fair, poor]
 *               notes: { type: string }
 *     responses:
 *       201:
 *         description: Device registered
 *       400:
 *         description: gadgetId is required
 *       404:
 *         description: Gadget not found
 */
router.post("/", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const {
      gadgetId,
      purchasePrice,
      purchaseDate,
      condition = "good",
      notes,
    } = req.body;
    if (!gadgetId) return sendError(res, 400, "gadgetId is required");

    const gadget = await Gadget.findById(gadgetId);
    if (!gadget) return sendError(res, 404, "Gadget not found");

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
    sendSuccess(res, 201, "Device registered", { device });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/devices/{id}:
 *   get:
 *     summary: Get a single owned device by ID
 *     tags: [Devices]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Device fetched
 *       404:
 *         description: Device not found
 */
router.get("/:id", protect, async (req, res, next) => {
  try {
    const device = await Device.findOne({
      _id: req.params.id,
      owner: req.user._id,
    }).populate("gadget");
    if (!device) return sendError(res, 404, "Device not found");
    sendSuccess(res, 200, "Device fetched", { device });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/devices/{id}:
 *   delete:
 *     summary: Remove an owned device
 *     tags: [Devices]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Device removed
 *       404:
 *         description: Device not found
 */
router.delete("/:id", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const device = await Device.findOneAndDelete({
      _id: req.params.id,
      owner: req.user._id,
    });
    if (!device) return sendError(res, 404, "Device not found");
    sendSuccess(res, 200, "Device removed");
  } catch (err) {
    next(err);
  }
});

module.exports = router;
