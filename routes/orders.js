const express = require("express");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Product = require("../models/Product");
const { protect } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/response");
const router = express.Router();

router.use(protect);

/**
 * @swagger
 * /api/orders:
 *   get:
 *     summary: The logged-in user's orders (newest first)
 *     tags: [Orders]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, paid, failed, cancelled] }
 *       - in: query
 *         name: kind
 *         schema: { type: string, enum: [cart, listing, swap] }
 *     responses:
 *       200:
 *         description: Orders fetched
 */
router.get("/", async (req, res, next) => {
  try {
    const filter = { buyer: req.user._id };
    const { status, kind } = req.query;
    if (["pending", "paid", "failed", "cancelled"].includes(status))
      filter.status = status;
    if (["cart", "listing", "swap"].includes(kind)) filter.kind = kind;

    const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(100);
    sendSuccess(res, 200, "Orders fetched", {
      orders: orders.map((o) => o.toClient()),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/orders/buy-again:
 *   get:
 *     summary: Catalog products the user has paid for before, with today's price and stock
 *     description: Powers a "Buy again" shelf. Most recently bought first, one entry per product + condition.
 *     tags: [Orders]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Previously bought products fetched
 */
router.get("/buy-again", async (req, res, next) => {
  try {
    const orders = await Order.find({
      buyer: req.user._id,
      kind: "cart",
      status: "paid",
    })
      .sort({ paidAt: -1, createdAt: -1 })
      .limit(50);

    // Dedupe by product + condition, keeping the most recent purchase
    const seen = new Map();
    for (const order of orders) {
      for (const item of order.items) {
        const key = `${item.itemId}|${item.condition}`;
        if (seen.has(key)) continue;
        seen.set(key, {
          itemId: item.itemId,
          condition: item.condition,
          lastBoughtAt: order.paidAt || order.createdAt,
          lastPrice: item.unitPrice,
          lastOrderId: String(order._id),
          timesBought: 0,
        });
      }
    }
    for (const order of orders)
      for (const item of order.items) {
        const entry = seen.get(`${item.itemId}|${item.condition}`);
        if (entry) entry.timesBought += item.quantity;
      }

    const slugs = [...new Set([...seen.values()].map((e) => e.itemId))];
    const products = await Product.find({ slug: { $in: slugs } });
    const bySlug = new Map(products.map((p) => [p.slug, p]));

    const items = [...seen.values()].map((entry) => {
      const product = bySlug.get(entry.itemId);
      const available = !!product && product.isActive && product.inStock;
      return {
        ...entry,
        available,
        currentPrice: product ? product.priceFor(entry.condition) : null,
        product: product && product.isActive ? product.toClient() : null,
      };
    });

    sendSuccess(res, 200, "Buy again items fetched", { items });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/orders/{id}:
 *   get:
 *     summary: One of the user's orders
 *     tags: [Orders]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Order fetched
 *       404:
 *         description: Order not found
 */
router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return sendError(res, 404, "Order not found");
    const order = await Order.findOne({ _id: req.params.id, buyer: req.user._id });
    if (!order) return sendError(res, 404, "Order not found");
    sendSuccess(res, 200, "Order fetched", { order: order.toClient() });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/orders/{id}/buy-again:
 *   get:
 *     summary: Rebuild a past catalog order as cart lines at today's prices
 *     description: >
 *       Returns `items` in the frontend CartLine shape ({ itemId, itemType,
 *       condition, quantity }) ready to load into the cart and send to
 *       POST /api/checkout/initialize. Items that are no longer sold or are
 *       out of stock come back in `unavailable`; price changes since the
 *       original order are listed in `priceChanges`.
 *     tags: [Orders]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cart lines built
 *       400:
 *         description: Only catalog orders can be bought again
 *       404:
 *         description: Order not found
 */
router.get("/:id/buy-again", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return sendError(res, 404, "Order not found");
    const order = await Order.findOne({ _id: req.params.id, buyer: req.user._id });
    if (!order) return sendError(res, 404, "Order not found");
    if (order.kind !== "cart")
      return sendError(
        res,
        400,
        "Only catalog orders can be bought again — marketplace listings and swaps are one-off deals."
      );

    const products = await Product.find({
      slug: { $in: order.items.map((i) => i.itemId) },
    });
    const bySlug = new Map(products.map((p) => [p.slug, p]));

    const items = [];
    const unavailable = [];
    const priceChanges = [];

    for (const line of order.items) {
      const product = bySlug.get(line.itemId);
      if (!product || !product.isActive) {
        unavailable.push({ itemId: line.itemId, name: line.name, reason: "no_longer_sold" });
        continue;
      }
      if (!product.inStock) {
        unavailable.push({ itemId: line.itemId, name: line.name, reason: "out_of_stock" });
        continue;
      }
      const currentPrice = product.priceFor(line.condition);
      if (currentPrice !== line.unitPrice)
        priceChanges.push({
          itemId: line.itemId,
          name: product.name,
          oldPrice: line.unitPrice,
          newPrice: currentPrice,
        });
      items.push({
        itemId: product.slug,
        itemType: product.type,
        condition: line.condition,
        quantity: line.quantity,
        name: product.name,
        unitPrice: currentPrice,
      });
    }

    sendSuccess(res, 200, "Cart rebuilt from order", {
      items,
      unavailable,
      priceChanges,
      subtotal: items.reduce((s, i) => s + i.unitPrice * i.quantity, 0),
      // Prefill the checkout form with the last delivery details
      delivery: {
        buyerName: order.buyerName,
        buyerEmail: order.buyerEmail,
        buyerPhone: order.buyerPhone,
        deliveryAddress: order.deliveryAddress,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
