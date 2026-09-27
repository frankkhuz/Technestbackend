const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Listing = require("../models/Listing");
const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const PayoutAccount = require("../models/PayoutAccount");
const { protect } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const paystack = require("../utils/paystack");
const { settleOrder } = require("../utils/orderEffects");
const {
  computeListingCheckout,
  isValidNigerianPhone,
} = require("../utils/pricing");
const router = express.Router();

const isObjectId = (id) => mongoose.isValidObjectId(id);

const requirePaystack = (req, res, next) => {
  if (!paystack.isConfigured())
    return sendError(
      res,
      503,
      "Checkout is not configured yet. Add PAYSTACK_SECRET_KEY to the backend .env to enable payments."
    );
  next();
};

// Works out what a listing costs a buyer, and whether it can be bought at all.
// Shared by the preview endpoint and the real checkout so they always agree.
const resolveListingPurchase = async (listingId, user) => {
  if (!isObjectId(listingId))
    return { error: "That listing could not be found.", status: 404 };

  const listing = await Listing.findById(listingId);
  if (!listing || !listing.owner)
    return { error: "That listing could not be found.", status: 404 };
  if (listing.status !== "active")
    return { error: "This listing is no longer available.", status: 409 };
  if (listing.owner.toString() === user._id.toString())
    return { error: "You can't buy your own listing.", status: 400 };

  const payoutAccount = await PayoutAccount.findOne({ user: listing.owner });
  if (!payoutAccount)
    return {
      error:
        "This seller hasn't set up payouts yet — try reaching them on WhatsApp instead.",
      status: 409,
    };

  return {
    listing,
    payoutAccount,
    ...computeListingCheckout(listing.estimatedMax),
  };
};

/**
 * @swagger
 * /api/checkout/listing-preview:
 *   get:
 *     summary: Price breakdown for buying a marketplace listing (seller price + platform fee)
 *     tags: [Checkout]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: listingId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Preview computed
 *       409:
 *         description: Listing unavailable or seller has no payout account
 */
router.get("/listing-preview", protect, async (req, res, next) => {
  try {
    const { listingId } = req.query;
    if (!listingId) return sendError(res, 400, "Missing listingId.");

    const result = await resolveListingPurchase(listingId, req.user);
    if (result.error) return sendError(res, result.status, result.error);

    sendSuccess(res, 200, "Preview computed", {
      preview: {
        listingId: String(result.listing._id),
        deviceName: result.listing.deviceName,
        sellerPrice: result.sellerPrice,
        platformFee: result.platformFee,
        totalCharge: result.totalCharge,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/checkout/initialize:
 *   post:
 *     summary: Create an order and start a Paystack payment
 *     description: >
 *       Send exactly one of `items` (catalog cart), `listingId` (buy a
 *       marketplace listing) or `swapTransactionId` (pay a swap top-up).
 *       Prices are always computed server-side. Redirect the browser to the
 *       returned authorizationUrl; Paystack sends the buyer back to
 *       CLIENT_URL/checkout/callback?reference=...
 *     tags: [Checkout]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [buyerName, buyerEmail, buyerPhone, deliveryAddress]
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     itemId: { type: string, example: iphone-17-pro-max }
 *                     itemType: { type: string, enum: [phone, gadget] }
 *                     condition: { type: string, enum: [uk-used, brand-new] }
 *                     quantity: { type: integer, minimum: 1, maximum: 20 }
 *               listingId: { type: string }
 *               swapTransactionId: { type: string }
 *               buyerName: { type: string }
 *               buyerEmail: { type: string }
 *               buyerPhone: { type: string, example: "08012345678" }
 *               deliveryAddress: { type: string }
 *     responses:
 *       201:
 *         description: Order created, payment started
 *       400:
 *         description: Invalid input
 *       503:
 *         description: Paystack not configured
 */
router.post(
  "/initialize",
  protect,
  verifyCsrfToken,
  requirePaystack,
  async (req, res, next) => {
    try {
      const { items, listingId, swapTransactionId } = req.body;
      const buyerName = String(req.body.buyerName || "").trim();
      const buyerEmail = String(req.body.buyerEmail || "").trim();
      const buyerPhone = String(req.body.buyerPhone || "").trim();
      const deliveryAddress = String(req.body.deliveryAddress || "").trim();

      const modes = [
        Array.isArray(items) && items.length > 0,
        !!listingId,
        !!swapTransactionId,
      ].filter(Boolean).length;

      if (!buyerName || !buyerEmail || !buyerPhone || !deliveryAddress || modes !== 1)
        return sendError(res, 400, "Please fill in all fields.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail))
        return sendError(res, 400, "Enter a valid email address.");
      if (!isValidNigerianPhone(buyerPhone))
        return sendError(res, 400, "Enter a valid Nigerian phone number.");

      const base = {
        buyer: req.user._id,
        buyerName,
        buyerEmail,
        buyerPhone,
        deliveryAddress,
      };
      let orderFields;
      let metadata;
      let split;

      if (swapTransactionId) {
        // ── Swap price-difference top-up ──────────────────────────────────
        if (!isObjectId(swapTransactionId))
          return sendError(res, 404, "Swap request not found.");
        const txn = await Transaction.findById(swapTransactionId);
        if (!txn || txn.type !== "swap")
          return sendError(res, 404, "Swap request not found.");
        if (txn.buyer.toString() !== req.user._id.toString())
          return sendError(res, 403, "This isn't your swap request.");
        if (!["pending", "accepted"].includes(txn.status))
          return sendError(res, 400, "This swap request is closed.");
        if (txn.topUpAmount <= 0)
          return sendError(res, 400, "No payment is needed for this swap.");
        if (txn.topUpPaid)
          return sendError(res, 400, "You've already paid for this swap.");

        const name = `Swap top-up: ${txn.swapDetails.offeredDeviceName} → ${txn.listingDeviceName}`;
        orderFields = {
          kind: "swap",
          transaction: txn._id,
          amount: txn.topUpAmount,
          items: [
            {
              itemId: String(txn._id),
              itemType: "swap",
              name,
              unitPrice: txn.topUpAmount,
              quantity: 1,
            },
          ],
        };
        metadata = { swapTransactionId: String(txn._id), buyerName };
      } else if (listingId) {
        // ── Marketplace listing purchase (split to seller subaccount) ─────
        const result = await resolveListingPurchase(listingId, req.user);
        if (result.error) return sendError(res, result.status, result.error);
        const { listing, payoutAccount, sellerPrice, platformFee, totalCharge } =
          result;

        orderFields = {
          kind: "listing",
          listing: listing._id,
          seller: listing.owner,
          sellerAmount: sellerPrice,
          platformFee,
          subaccountCode: payoutAccount.subaccountCode,
          amount: totalCharge,
          items: [
            {
              itemId: String(listing._id),
              itemType: "listing",
              name: listing.deviceName,
              spec: listing.storage || null,
              unitPrice: totalCharge,
              quantity: 1,
            },
          ],
        };
        metadata = { listingId: String(listing._id), buyerName };
        split = {
          subaccountCode: payoutAccount.subaccountCode,
          platformFeeKobo: Math.round(platformFee * 100),
        };
      } else {
        // ── Catalog cart (one or many items) ──────────────────────────────
        if (items.length > 50)
          return sendError(res, 400, "Too many items in one order.");

        const slugs = [...new Set(items.map((i) => String(i?.itemId || "").toLowerCase()))];
        const products = await Product.find({ slug: { $in: slugs } });
        const bySlug = new Map(products.map((p) => [p.slug, p]));

        const lineItems = [];
        for (const line of items) {
          const product = bySlug.get(String(line?.itemId || "").toLowerCase());
          if (!product || !product.isActive)
            return sendError(res, 404, "One of the items in your cart could not be found.");
          if (!product.inStock)
            return sendError(res, 409, `${product.name} is out of stock.`);
          if (line.itemType && line.itemType !== product.type)
            return sendError(res, 400, "One of the items in your cart is invalid.");
          if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20)
            return sendError(res, 400, "Invalid quantity.");
          const condition = line.condition === "brand-new" ? "brand-new" : "uk-used";

          lineItems.push({
            itemId: product.slug,
            itemType: product.type,
            name: product.name,
            spec: product.type === "phone" ? product.storage[0] || null : product.spec,
            condition,
            unitPrice: product.priceFor(condition),
            quantity: line.quantity,
          });
        }

        const amount = lineItems.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
        orderFields = { kind: "cart", amount, items: lineItems };
        metadata = { itemName: lineItems[0].name, buyerName, itemCount: lineItems.length };
      }

      const order = new Order({ ...base, ...orderFields });
      order.reference = `TN-${order._id}`;
      await order.save();

      const result = await paystack.initializeTransaction({
        email: buyerEmail,
        amountNaira: order.amount,
        reference: order.reference,
        metadata: { ...metadata, orderId: String(order._id) },
        split,
      });
      if (result.error) {
        order.status = "cancelled";
        await order.save();
        return sendError(res, 502, result.error);
      }

      sendSuccess(res, 201, "Checkout started", {
        authorizationUrl: result.authorizationUrl,
        reference: order.reference,
        order: order.toClient(),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/checkout/verify:
 *   get:
 *     summary: Confirm a payment after Paystack redirects back (idempotent)
 *     tags: [Checkout]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: reference
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Order status (pending, paid or failed)
 *       404:
 *         description: Order not found
 */
router.get("/verify", protect, requirePaystack, async (req, res, next) => {
  try {
    const { reference } = req.query;
    if (!reference || typeof reference !== "string")
      return sendError(res, 400, "Missing reference.");

    const existing = await Order.findOne({ reference });
    if (!existing) return sendError(res, 404, "Order not found.");
    if (existing.buyer.toString() !== req.user._id.toString())
      return sendError(res, 403, "This isn't your order.");

    const result = await settleOrder(reference);
    if (result.error) return sendError(res, result.status || 500, result.error);

    sendSuccess(res, 200, "Order status fetched", { order: result.order.toClient() });
  } catch (err) {
    next(err);
  }
});

// Paystack webhook — mounted in server.js with a raw body parser (needed to
// check the signature), outside this router's JSON/CSRF middleware. Set the
// webhook URL in the Paystack dashboard to <backend>/api/checkout/webhook.
const webhookHandler = async (req, res) => {
  const signature = req.headers["x-paystack-signature"];
  if (!paystack.isValidWebhookSignature(req.body, signature))
    return res.sendStatus(401);

  // Acknowledge fast — Paystack retries anything that isn't a quick 200
  res.sendStatus(200);

  try {
    const event = JSON.parse(req.body.toString("utf8"));
    const reference = event?.data?.reference;
    if (event?.event === "charge.success" && typeof reference === "string") {
      await settleOrder(reference);
    }
  } catch (err) {
    console.error("Paystack webhook handling failed:", err.message);
  }
};

module.exports = router;
module.exports.webhookHandler = webhookHandler;
module.exports.resolveListingPurchase = resolveListingPurchase;
