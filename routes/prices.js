const express = require("express");
const { Gadget } = require("../models/Gadget");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const router = express.Router();

/**
 * @swagger
 * /api/prices/{gadgetId}:
 *   get:
 *     summary: Get full price history for a gadget
 *     tags: [Prices]
 *     parameters:
 *       - in: path
 *         name: gadgetId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Price history fetched
 *       404:
 *         description: Gadget not found
 */
router.get("/:gadgetId", async (req, res, next) => {
  try {
    const gadget = await Gadget.findById(req.params.gadgetId).select(
      "name brand currentPrice currency priceHistory"
    );
    if (!gadget) return sendError(res, 404, "Gadget not found");
    sendSuccess(res, 200, "Price history fetched", { gadget });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/prices/{gadgetId}:
 *   patch:
 *     summary: Update the current price of a gadget
 *     tags: [Prices]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: gadgetId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [price]
 *             properties:
 *               price: { type: number }
 *     responses:
 *       200:
 *         description: Price updated
 *       400:
 *         description: A valid price is required
 *       404:
 *         description: Gadget not found
 */
router.patch(
  "/:gadgetId",
  protect,
  restrictTo("admin"),
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const { price } = req.body;

      if (!price || isNaN(price) || Number(price) <= 0)
        return sendError(res, 400, "A valid price is required");

      const gadget = await Gadget.findById(req.params.gadgetId);
      if (!gadget) return sendError(res, 404, "Gadget not found");

      gadget.priceHistory.push({
        price: gadget.currentPrice,
        recordedAt: new Date(),
      });
      gadget.currentPrice = Number(price);
      await gadget.save();

      sendSuccess(res, 200, "Price updated", {
        currentPrice: gadget.currentPrice,
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
