const express = require("express");
const mongoose = require("mongoose");
const OrderRequest = require("../models/OrderRequest");
const Listing = require("../models/Listing");
const Transaction = require("../models/Transaction");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { notify } = require("../utils/notify");
const { reserveListing, releaseListing, RESERVATION_HOURS } = require("../utils/availability");
const { whatsappLink } = require("./orderRequests");
const { settleAmounts } = require("../utils/finance");
const { takeFromStock } = require("../utils/stock");
const router = express.Router();

router.use(protect, restrictTo("admin"));

const DELIVERY_STEPS = ["not_started", "ready_for_pickup", "out_for_delivery", "delivered", "collected"];

const TRANSITIONS = {
  new: ["in_progress", "cancelled"],
  in_progress: ["in_progress", "completed", "cancelled"], // in_progress again = extend the hold
  completed: [],
  cancelled: [],
};

/**
 * @swagger
 * /api/admin/order-requests:
 *   get:
 *     summary: WhatsApp orders to follow up
 *     tags: [Admin — Orders]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [new, in_progress, completed, cancelled] }
 *       - in: query
 *         name: q
 *         schema: { type: string, description: "Reference, buyer name or phone" }
 *     responses:
 *       200:
 *         description: data.requests (with adminNotes, buyer, listing status and whatsappUrl), data.counts per status
 */
router.get("/", async (req, res, next) => {
  try {
    const filter = {};
    if (TRANSITIONS[req.query.status]) filter.status = req.query.status;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 50) : "";
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ reference: rx }, { buyerName: rx }, { buyerPhone: rx }];
    }
    const [requests, counts] = await Promise.all([
      OrderRequest.find(filter)
        .populate("buyer", "name email")
        .populate("listing", "deviceName status reservedUntil reservedFor owner userName userPhone")
        .populate("handledBy", "name")
        .sort({ createdAt: -1 })
        .limit(200),
      OrderRequest.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    sendSuccess(res, 200, "Order requests fetched", {
      requests: requests.map((r) => ({
        ...r.toClient(),
        adminNotes: r.adminNotes,
        finalPrice: r.finalPrice ?? undefined,
        commission: r.commission ?? undefined,
        sellerPayout: r.sellerPayout ?? undefined,
        payoutStatus: r.payoutStatus,
        buyer: r.buyer,
        listing: r.listing,
        handledBy: r.handledBy,
        whatsappUrl: whatsappLink(r),
      })),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/order-requests/{id}:
 *   patch:
 *     summary: Move a WhatsApp order along
 *     description: >
 *       `in_progress` holds a marketplace listing for this buyer for 48 hours
 *       (send in_progress again to extend), and tells the seller.
 *       `completed` marks the listing sold and closes other requests on it.
 *       `cancelled` releases the hold. The buyer is notified if they have an
 *       account.
 *     tags: [Admin — Orders]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status: { type: string, enum: [in_progress, completed, cancelled] }
 *               adminNotes: { type: string, maxLength: 1000 }
 *               delivery:
 *                 type: object
 *                 description: Any of these; the buyer is notified when status changes
 *                 properties:
 *                   fee: { type: number }
 *                   status: { type: string, enum: [not_started, ready_for_pickup, out_for_delivery, delivered, collected] }
 *                   riderName: { type: string }
 *                   riderPhone: { type: string }
 *                   address: { type: string }
 *                   city: { type: string }
 *               finalPrice: { type: number, description: "completed only — what the buyer actually paid (default: the order amount)" }
 *               commission: { type: number, description: "completed only — TechNest's share (default: the whole price for cart orders, PLATFORM_FEE_PERCENT for listings). For a listing the seller is owed finalPrice − commission." }
 *     responses:
 *       200:
 *         description: data.request
 *       409:
 *         description: Not allowed from the current status, or the listing is gone/held for someone else
 */
router.patch("/:id", verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Order request not found");
    const request = await OrderRequest.findById(req.params.id);
    if (!request) return sendError(res, 404, "Order request not found");

    if (typeof req.body.adminNotes === "string") request.adminNotes = req.body.adminNotes.slice(0, 1000);

    // Delivery: fee, rider and progress — tell the buyer when it moves
    const d = req.body.delivery;
    let deliveryNews = null;
    if (d && typeof d === "object") {
      if (d.fee !== undefined) {
        const fee = Number(d.fee);
        if (!Number.isFinite(fee) || fee < 0) return sendError(res, 400, "delivery.fee must be an amount in naira.");
        request.delivery.fee = Math.round(fee);
      }
      for (const f of ["riderName", "riderPhone", "address", "city"])
        if (typeof d[f] === "string") request.delivery[f] = d[f].trim().slice(0, f === "address" ? 300 : 80) || null;
      if (d.status !== undefined && d.status !== request.delivery.status) {
        if (!DELIVERY_STEPS.includes(d.status)) return sendError(res, 400, `delivery.status must be one of: ${DELIVERY_STEPS.join(", ")}`);
        if (!["in_progress", "completed"].includes(req.body.status || request.status))
          return sendError(res, 409, "Start the order (in_progress) before updating delivery.");
        request.delivery.status = d.status;
        deliveryNews = d.status;
      }
      request.delivery.updatedAt = new Date();
    }
    const next_ = req.body.status;
    if (next_ !== undefined && !TRANSITIONS[request.status].includes(next_))
      return sendError(res, 409, `Can't move a ${request.status} request to ${next_}.`);

    const buyerUpdate = (title, message) =>
      request.buyer &&
      notify({ recipient: request.buyer, type: "order_request", title, message, orderRequest: request._id });

    if (next_ === "in_progress") {
      if (request.listing) {
        const held = await reserveListing(request.listing, request._id);
        if (!held) return sendError(res, 409, "That listing is sold, removed or held for another buyer.");
        if (request.status === "new")
          await notify({
            recipient: held.owner,
            type: "listing_update",
            title: "A buyer wants your device",
            message: `A buyer wants your ${held.deviceName}. TechNest will contact you to arrange the sale — it's held for them for ${RESERVATION_HOURS} hours.`,
            listing: held._id,
          });
      }
      if (request.status === "new")
        await buyerUpdate(`We're on your order ${request.reference}`, "Our team is arranging your order and will keep you posted on WhatsApp.");
    }

    let amounts = null;
    if (next_ === "completed") {
      // Cart items are TechNest's own sales; on a listing TechNest keeps its fee
      amounts = settleAmounts(req.body, {
        defaultPrice: request.amount,
        ...(request.listing ? {} : { defaultCommissionFor: (price) => price }),
      });
      if (amounts.error) return sendError(res, 400, amounts.error);
    }

    if (next_ === "completed" && request.listing) {
      const listing = await Listing.findOneAndUpdate(
        { _id: request.listing, status: "active" },
        { status: "sold", reservedUntil: null, reservedFor: null },
        { returnDocument: "after" }
      );
      if (!listing) return sendError(res, 409, "That listing is no longer active — check it before completing.");
      const open = await Transaction.find({ listing: listing._id, status: { $in: ["pending", "accepted"] } });
      await Transaction.updateMany({ _id: { $in: open.map((t) => t._id) } }, { status: "cancelled" });
      await OrderRequest.updateMany(
        { listing: listing._id, _id: { $ne: request._id }, status: { $in: ["new", "in_progress"] } },
        { status: "cancelled", adminNotes: "Listing sold to another buyer." }
      );
      await notify([
        {
          recipient: listing.owner,
          type: "listing_sold",
          title: "Your listing sold",
          message: `Your ${listing.deviceName} was sold through TechNest.`,
          listing: listing._id,
        },
        ...open.map((t) => ({
          recipient: t.buyer,
          type: "transaction_update",
          title: "Listing no longer available",
          message: `${t.listingDeviceName} has been sold, so your request was closed.`,
          listing: t.listing,
          transaction: t._id,
        })),
      ]);
    }
    if (next_ === "completed" && request.kind === "cart")
      await takeFromStock(request.items.filter((i) => i.itemType === "product").map((i) => ({ itemId: i.itemId, quantity: i.quantity })));
    if (next_ === "completed") {
      Object.assign(request, amounts, {
        sellerPayout: request.listing ? amounts.finalPrice - amounts.commission : 0,
        payoutStatus: request.listing ? "pending" : "none",
        completedAt: new Date(),
      });
    }
    if (next_ === "completed")
      await buyerUpdate(`Order ${request.reference} complete`, "Thanks for buying with TechNest!");
    if (next_ === "completed" && request.listing && request.buyer)
      await notify({
        recipient: request.buyer,
        type: "review_request",
        title: "How was the seller?",
        message: `Rate the seller of your ${request.items[0]?.name} — it helps other buyers.`,
        orderRequest: request._id,
        email: false,
      });

    if (next_ === "cancelled") {
      if (request.listing) await releaseListing(request.listing, request._id);
      await buyerUpdate(`Order ${request.reference} cancelled`, request.adminNotes ? `Your order was cancelled: ${request.adminNotes}`.slice(0, 500) : "Your order was cancelled. Reach us on WhatsApp if that's a mistake.");
    }

    if (deliveryNews && request.buyer) {
      const rider = request.delivery.riderName ? ` Rider: ${request.delivery.riderName}${request.delivery.riderPhone ? ` (${request.delivery.riderPhone})` : ""}.` : "";
      const text = {
        ready_for_pickup: "Your order is ready for pickup.",
        out_for_delivery: `Your order is on its way.${rider}`,
        delivered: "Your order was delivered. Enjoy!",
        collected: "You've collected your order. Enjoy!",
        not_started: "Your delivery hasn't started yet.",
      }[deliveryNews];
      await notify({ recipient: request.buyer, type: "order_request", title: `Order ${request.reference}`, message: text, orderRequest: request._id });
    }

    if (next_) {
      request.status = next_;
      request.handledBy = req.user._id;
    }
    await request.save();
    sendSuccess(res, 200, "Order request updated", {
      request: {
        ...request.toClient(),
        adminNotes: request.adminNotes,
        finalPrice: request.finalPrice ?? undefined,
        commission: request.commission ?? undefined,
        sellerPayout: request.sellerPayout ?? undefined,
        payoutStatus: request.payoutStatus,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
