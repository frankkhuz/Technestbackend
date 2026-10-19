const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const OrderRequest = require("../models/OrderRequest");
const Product = require("../models/Product");
const Listing = require("../models/Listing");
const { protect, optionalAuth } = require("../middleware/auth");
const { verifyCsrfIfAuthenticated } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { normalizeNigerianPhone } = require("../utils/pricing");
const { normalizeState } = require("../utils/nigeria");
const { listingUnavailableReason } = require("../utils/availability");
const { SUPPORT_WHATSAPP } = require("../utils/supportFaq");
const { notifyAdmins } = require("../utils/notify");
const paystack = require("../utils/paystack");
const router = express.Router();

const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  handler: (req, res) => sendError(res, 429, "Too many requests — please wait a few minutes."),
});

const naira = (n) => `₦${Math.round(n).toLocaleString()}`;

// The message pre-filled in WhatsApp, so staff see exactly what was asked for
const whatsappLink = (request) => {
  const lines = [
    `Hi TechNest, I'd like to buy:`,
    ...request.items.map(
      (i) => `• ${i.name}${i.spec ? ` (${i.spec})` : ""}${i.condition ? `, ${i.condition}` : ""} x${i.quantity} — ${naira(i.unitPrice * i.quantity)}`
    ),
    `Total: ${naira(request.amount)}`,
    request.delivery?.method === "pickup"
      ? "I'll pick it up"
      : request.delivery?.address
      ? `Deliver to: ${[request.delivery.address, request.delivery.city, request.state].filter(Boolean).join(", ")}`
      : "Delivery — I'll send my address here",
    `Ref: ${request.reference}`,
  ];
  return `https://wa.me/${SUPPORT_WHATSAPP()}?text=${encodeURIComponent(lines.join("\n"))}`;
};

const onlinePaymentsEnabled = () =>
  process.env.ONLINE_PAYMENTS === "on" && paystack.isConfigured();

/**
 * @swagger
 * /api/order-requests/options:
 *   get:
 *     summary: Which ways to pay are open right now
 *     description: >
 *       Show both buttons. "Chat with us on WhatsApp" is always on; "Pay on
 *       platform" shows `online.label` ("Coming soon") and stays disabled
 *       until ONLINE_PAYMENTS=on is set on the backend.
 *     tags: [Order Requests]
 *     security: []
 *     responses:
 *       200:
 *         description: "data: { whatsapp: { enabled, number }, online: { enabled, label } }"
 */
router.get("/options", (req, res) => {
  const online = onlinePaymentsEnabled();
  sendSuccess(res, 200, "Payment options", {
    whatsapp: { enabled: true, number: SUPPORT_WHATSAPP() },
    online: { enabled: online, label: online ? "Pay online" : "Coming soon" },
  });
});

/**
 * @swagger
 * /api/order-requests:
 *   post:
 *     summary: Buy through TechNest on WhatsApp — records the order and returns the WhatsApp link
 *     description: >
 *       Send either `items` (catalog cart) or `listingId` (a marketplace
 *       listing). Prices are always worked out by the server. Open to guests;
 *       logged-in buyers can track it under GET /api/order-requests/mine.
 *       Open `data.whatsappUrl` — the message already has the order and its
 *       reference.
 *     tags: [Order Requests]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [buyerName, buyerPhone]
 *             properties:
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     itemId: { type: string, description: product slug }
 *                     quantity: { type: integer }
 *                     condition: { type: string, enum: [uk-used, brand-new] }
 *               listingId: { type: string }
 *               buyerName: { type: string }
 *               buyerPhone: { type: string }
 *               buyerEmail: { type: string }
 *               state: { type: string, example: Lagos }
 *               note: { type: string, maxLength: 500 }
 *               deliveryMethod: { type: string, enum: [delivery, pickup], default: delivery }
 *               deliveryAddress: { type: string, description: "Optional — without it the buyer shares it on WhatsApp" }
 *               city: { type: string, example: Ikeja }
 *     responses:
 *       201:
 *         description: "data: { request, whatsappUrl }"
 *       400:
 *         description: Missing/invalid details
 *       404:
 *         description: Item not found
 *       409:
 *         description: Out of stock, or listing sold/reserved
 */
router.post("/", requestLimiter, optionalAuth, verifyCsrfIfAuthenticated, async (req, res, next) => {
  try {
    const { items, listingId } = req.body;
    const buyerName = String(req.body.buyerName || req.user?.name || "").trim().slice(0, 100);
    const buyerPhone = normalizeNigerianPhone(req.body.buyerPhone || "");
    const buyerEmail = String(req.body.buyerEmail || req.user?.email || "").trim() || null;

    const method = req.body.deliveryMethod === "pickup" ? "pickup" : "delivery";
    const address = String(req.body.deliveryAddress || "").trim().slice(0, 300);
    const city = String(req.body.city || "").trim().slice(0, 60);
    if (!buyerName) return sendError(res, 400, "Tell us your name.");
    if (!buyerPhone) return sendError(res, 400, "Enter a valid Nigerian phone number, e.g. 0803 123 4567.");
    if (buyerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail))
      return sendError(res, 400, "Enter a valid email address.");
    const hasItems = Array.isArray(items) && items.length > 0;
    if (hasItems === !!listingId) return sendError(res, 400, "Send either items or listingId.");

    let fields;
    if (listingId) {
      if (!mongoose.isValidObjectId(listingId)) return sendError(res, 404, "That listing could not be found.");
      const listing = await Listing.findById(listingId);
      const reason = listingUnavailableReason(listing);
      if (!listing) return sendError(res, 404, "That listing could not be found.");
      if (reason) return sendError(res, 409, reason);
      if (req.user && String(listing.owner) === String(req.user._id))
        return sendError(res, 400, "You can't buy your own listing.");
      fields = {
        kind: "listing",
        listing: listing._id,
        amount: listing.estimatedMax,
        items: [{ itemType: "listing", itemId: String(listing._id), name: listing.deviceName, spec: listing.storage || null, condition: "UK used", unitPrice: listing.estimatedMax, quantity: 1 }],
      };
    } else {
      if (items.length > 50) return sendError(res, 400, "Too many items in one order.");
      const slugs = [...new Set(items.map((i) => String(i?.itemId || "").toLowerCase()))];
      const products = await Product.find({ slug: { $in: slugs } });
      const bySlug = new Map(products.map((p) => [p.slug, p]));
      const lines = [];
      for (const line of items) {
        const product = bySlug.get(String(line?.itemId || "").toLowerCase());
        if (!product || !product.isActive) return sendError(res, 404, "One of the items in your cart could not be found.");
        if (!product.inStock) return sendError(res, 409, `${product.name} is out of stock.`);
        const quantity = Number.isInteger(line.quantity) ? line.quantity : 1;
        if (quantity < 1 || quantity > 20) return sendError(res, 400, "Invalid quantity.");
        const condition = line.condition === "brand-new" ? "brand-new" : "uk-used";
        lines.push({
          itemType: "product",
          itemId: product.slug,
          name: product.name,
          spec: product.type === "phone" ? product.storage[0] || null : product.spec,
          condition: condition === "brand-new" ? "Brand new" : "UK used",
          unitPrice: product.priceFor(condition),
          quantity,
        });
      }
      fields = { kind: "cart", items: lines, amount: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) };
    }

    const request = await OrderRequest.create({
      ...fields,
      buyer: req.user?._id || null,
      buyerName,
      buyerPhone,
      buyerEmail,
      state: normalizeState(req.body.state),
      note: typeof req.body.note === "string" ? req.body.note.slice(0, 500) : null,
      delivery: { method, address: method === "delivery" ? address : null, city: city || null },
    });

    await notifyAdmins({
      type: "order_request",
      title: `New WhatsApp order ${request.reference}`,
      message: `${buyerName} (${buyerPhone}) wants ${request.items.map((i) => i.name).join(", ")} — ${naira(request.amount)}.`.slice(0, 500),
      orderRequest: request._id,
      listing: request.listing,
    });

    sendSuccess(res, 201, "Order request created — continue on WhatsApp", {
      request: request.toClient(),
      whatsappUrl: whatsappLink(request),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/order-requests/mine:
 *   get:
 *     summary: The logged-in buyer's WhatsApp orders, with status
 *     tags: [Order Requests]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: data.requests (each with whatsappUrl to reopen the chat)
 */
router.get("/mine", protect, async (req, res, next) => {
  try {
    const requests = await OrderRequest.find({ buyer: req.user._id }).sort({ createdAt: -1 }).limit(100);
    sendSuccess(res, 200, "Order requests fetched", {
      requests: requests.map((r) => ({ ...r.toClient(), whatsappUrl: whatsappLink(r) })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.whatsappLink = whatsappLink;
