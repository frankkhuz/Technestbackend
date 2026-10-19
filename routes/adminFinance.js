const express = require("express");
const mongoose = require("mongoose");
const OrderRequest = require("../models/OrderRequest");
const DeviceRequest = require("../models/DeviceRequest");
const Order = require("../models/Order");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { notify } = require("../utils/notify");
const router = express.Router();

router.use(protect, restrictTo("admin"));

const parseDay = (s, endOfDay) => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00+01:00`); // Lagos time
  return endOfDay ? new Date(d.getTime() + 864e5) : d;
};

/**
 * @swagger
 * /api/admin/finance:
 *   get:
 *     summary: Sales, TechNest's earnings and money still owed
 *     description: >
 *       Counts completed WhatsApp orders, completed customer requests and
 *       paid online orders between `from` and `to` (Lagos dates, default:
 *       this month). `revenue` is TechNest's share — the whole price for
 *       catalog orders, the commission for listings and requests.
 *       `outstanding` (all time) lists sellers TechNest still has to pay
 *       and vendors who still owe commission.
 *     tags: [Admin — Finance]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, example: "2026-10-01" }
 *       - in: query
 *         name: to
 *         schema: { type: string, example: "2026-10-31" }
 *     responses:
 *       200:
 *         description: "data: { from, to, totals: { count, sales, revenue }, byChannel, byMonth, outstanding: { owedToSellers, owedByVendors, payoutsOnHold, sellerPayouts[], vendorCommissions[] } }"
 */
router.get("/", async (req, res, next) => {
  try {
    const now = new Date();
    const lagosMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 3600e3);
    const from = parseDay(req.query.from) || lagosMonthStart;
    const to = parseDay(req.query.to, true) || now;
    const inRange = { $gte: from, $lt: to };

    const [orderReqs, deviceReqs, onlineOrders] = await Promise.all([
      OrderRequest.find({ status: "completed", completedAt: inRange }).select("kind finalPrice commission completedAt"),
      DeviceRequest.find({ status: "completed", completedAt: inRange }).select("finalPrice commission completedAt"),
      Order.find({ status: "paid", paidAt: inRange }).select("kind amount platformFee paidAt"),
    ]);

    // One row per deal: { channel, sales, revenue, at }
    const deals = [
      ...orderReqs.map((o) => ({ channel: o.kind === "listing" ? "whatsappListings" : "whatsappCatalog", sales: o.finalPrice || 0, revenue: o.commission || 0, at: o.completedAt })),
      ...deviceReqs.map((r) => ({ channel: "requests", sales: r.finalPrice || 0, revenue: r.commission || 0, at: r.completedAt })),
      // Online: a listing purchase earns the platform fee; a swap top-up or cart order is TechNest's
      ...onlineOrders.map((o) => ({ channel: "online", sales: o.amount, revenue: o.kind === "listing" ? o.platformFee || 0 : o.amount, at: o.paidAt })),
    ];
    const sum = (rows) => ({
      count: rows.length,
      sales: rows.reduce((s, d) => s + d.sales, 0),
      revenue: rows.reduce((s, d) => s + d.revenue, 0),
    });
    const byChannel = Object.fromEntries(
      ["whatsappCatalog", "whatsappListings", "requests", "online"].map((c) => [c, sum(deals.filter((d) => d.channel === c))])
    );
    const months = new Map();
    for (const d of deals) {
      const key = new Date(d.at.getTime() + 3600e3).toISOString().slice(0, 7);
      months.set(key, [...(months.get(key) || []), d]);
    }

    // Outstanding, regardless of dates
    const [payouts, dues, onHold] = await Promise.all([
      OrderRequest.find({ payoutStatus: "pending" })
        .populate({ path: "listing", select: "deviceName owner", populate: { path: "owner", select: "name email" } })
        .sort({ completedAt: 1 }),
      DeviceRequest.find({ commissionStatus: "due" }).populate("acceptedVendor", "name email vendorProfile.businessName").sort({ completedAt: 1 }),
      OrderRequest.find({ payoutStatus: "on_hold" }).select("sellerPayout"),
    ]);
    const byVendor = new Map();
    for (const r of dues) {
      const id = String(r.acceptedVendor?._id || r.acceptedVendor);
      const row = byVendor.get(id) || {
        vendor: { id, name: r.acceptedVendor?.vendorProfile?.businessName || r.acceptedVendor?.name, email: r.acceptedVendor?.email },
        amount: 0,
        requests: [],
      };
      row.amount += r.commission;
      row.requests.push({ id: String(r._id), reference: r.reference, deviceName: r.deviceName, commission: r.commission, completedAt: r.completedAt });
      byVendor.set(id, row);
    }

    sendSuccess(res, 200, "Finance report", {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: sum(deals),
      byChannel,
      byMonth: [...months.entries()].sort().map(([month, rows]) => ({ month, ...sum(rows) })),
      outstanding: {
        owedToSellers: payouts.reduce((s, o) => s + (o.sellerPayout || 0), 0),
        owedByVendors: dues.reduce((s, r) => s + (r.commission || 0), 0),
        // Payouts frozen by an open dispute
        payoutsOnHold: onHold.reduce((s, o) => s + (o.sellerPayout || 0), 0),
        sellerPayouts: payouts.map((o) => ({
          id: String(o._id),
          reference: o.reference,
          deviceName: o.listing?.deviceName,
          seller: o.listing?.owner ? { id: String(o.listing.owner._id), name: o.listing.owner.name, email: o.listing.owner.email } : null,
          amount: o.sellerPayout,
          completedAt: o.completedAt,
        })),
        vendorCommissions: [...byVendor.values()].sort((a, b) => b.amount - a.amount),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/finance/payouts/{orderRequestId}:
 *   patch:
 *     summary: Record that TechNest paid the seller of a listing order
 *     tags: [Admin — Finance]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: orderRequestId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reference: { type: string, description: "Bank transfer reference" }
 *     responses:
 *       200:
 *         description: Marked paid; the seller is notified
 *       409:
 *         description: Nothing pending for this order
 * /api/admin/finance/commissions/{requestId}:
 *   patch:
 *     summary: Record that a vendor paid TechNest's commission on a request
 *     tags: [Admin — Finance]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reference: { type: string }
 *     responses:
 *       200:
 *         description: Marked collected; the vendor gets a receipt notification
 *       409:
 *         description: No commission due on this request
 */
router.patch("/payouts/:id", verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Order not found");
    const order = await OrderRequest.findOneAndUpdate(
      { _id: req.params.id, payoutStatus: "pending" },
      { payoutStatus: "paid", payoutPaidAt: new Date(), payoutReference: String(req.body?.reference || "").slice(0, 100) || null },
      { returnDocument: "after" }
    ).populate("listing", "deviceName owner");
    if (!order) return sendError(res, 409, "There's no pending payout on this order.");
    if (order.listing?.owner)
      await notify({
        recipient: order.listing.owner,
        type: "listing_update",
        title: "TechNest has paid you",
        message: `We've sent you ₦${order.sellerPayout.toLocaleString()} for your ${order.listing.deviceName} (order ${order.reference}).`,
        listing: order.listing._id,
        orderRequest: order._id,
      });
    sendSuccess(res, 200, "Payout recorded", { id: String(order._id), payoutStatus: order.payoutStatus, payoutPaidAt: order.payoutPaidAt });
  } catch (err) {
    next(err);
  }
});

router.patch("/commissions/:id", verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Request not found");
    const request = await DeviceRequest.findOneAndUpdate(
      { _id: req.params.id, commissionStatus: "due" },
      { commissionStatus: "collected", commissionCollectedAt: new Date(), commissionReference: String(req.body?.reference || "").slice(0, 100) || null },
      { returnDocument: "after" }
    );
    if (!request) return sendError(res, 409, "There's no commission due on this request.");
    await notify({
      recipient: request.acceptedVendor,
      type: "account_update",
      title: "Commission payment received",
      message: `Thanks — we've received your ₦${request.commission.toLocaleString()} commission for request ${request.reference}.`,
      deviceRequest: request._id,
    });
    sendSuccess(res, 200, "Commission recorded", { id: String(request._id), commissionStatus: request.commissionStatus });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
