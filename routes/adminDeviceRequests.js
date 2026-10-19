const express = require("express");
const mongoose = require("mongoose");
const DeviceRequest = require("../models/DeviceRequest");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { notify } = require("../utils/notify");
const { findMatchingVendors, settleIfExpired } = require("../utils/matching");
const { customerView } = require("./deviceRequests");
const { settleAmounts } = require("../utils/finance");
const router = express.Router();

router.use(protect, restrictTo("admin"));

/**
 * @swagger
 * /api/admin/requests:
 *   get:
 *     summary: Customer requests and their offers
 *     tags: [Admin — Requests]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, accepted, completed, cancelled, expired] }
 *       - in: query
 *         name: unmatched
 *         description: "true = only requests no vendor was matched to"
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "data.requests (with customer { name, email }, adminNotes, acceptedVendor), data.counts"
 */
router.get("/", async (req, res, next) => {
  try {
    const filter = {};
    if (["open", "accepted", "completed", "cancelled", "expired"].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.unmatched === "true") filter.matchedVendors = { $size: 0 };
    const [found, counts] = await Promise.all([
      DeviceRequest.find(filter)
        .populate("customer", "name email")
        .populate("acceptedVendor", "name email vendorProfile.businessName vendorProfile.phone")
        .sort({ createdAt: -1 })
        .limit(200),
      DeviceRequest.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const requests = [];
    for (const r of found) {
      const fresh = await settleIfExpired(r);
      requests.push({
        ...(await customerView(fresh)),
        customer: r.customer,
        acceptedVendor: r.acceptedVendor,
        adminNotes: fresh.adminNotes,
        finalPrice: fresh.finalPrice ?? undefined,
        commission: fresh.commission ?? undefined,
        commissionStatus: fresh.commissionStatus,
      });
    }
    sendSuccess(res, 200, "Requests fetched", {
      requests,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/requests/{id}:
 *   patch:
 *     summary: Mark an accepted request completed (or cancel it), with notes
 *     tags: [Admin — Requests]
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
 *               status: { type: string, enum: [completed, cancelled] }
 *               adminNotes: { type: string }
 *               finalPrice: { type: number, description: "completed only — the deal's final price (default: the accepted offer)" }
 *               commission: { type: number, description: "completed only — what the vendor owes TechNest (default: PLATFORM_FEE_PERCENT of finalPrice)" }
 *     responses:
 *       200:
 *         description: data.request
 *       409:
 *         description: Not allowed from the current status
 */
router.patch("/:id", verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Request not found");
    const request = await DeviceRequest.findById(req.params.id);
    if (!request) return sendError(res, 404, "Request not found");
    if (typeof req.body.adminNotes === "string") request.adminNotes = req.body.adminNotes.slice(0, 1000);

    const { status } = req.body;
    if (status === "completed") {
      if (request.status !== "accepted") return sendError(res, 409, "Only accepted requests can be completed.");
      const accepted = request.offers.id(request.acceptedOffer);
      const amounts = settleAmounts(req.body, { defaultPrice: accepted?.price ?? 0 });
      if (amounts.error) return sendError(res, 400, amounts.error);
      Object.assign(request, amounts, { commissionStatus: amounts.commission > 0 ? "due" : "none" });
      request.status = "completed";
      request.completedAt = new Date();
      await notify({
        recipient: request.customer,
        type: "device_request",
        title: `Request ${request.reference} completed`,
        message: `Your ${request.type} request for "${request.deviceName}" is complete. Thanks for using TechNest!`,
        deviceRequest: request._id,
      });
    } else if (status === "cancelled") {
      if (!["open", "accepted"].includes(request.status)) return sendError(res, 409, "This request is already closed.");
      request.status = "cancelled";
      for (const o of request.offers) if (["active", "accepted"].includes(o.status)) o.status = "declined";
      await notify({
        recipient: request.customer,
        type: "device_request",
        title: `Request ${request.reference} cancelled`,
        message: request.adminNotes ? `Your request was cancelled: ${request.adminNotes}`.slice(0, 500) : "Your request was cancelled by TechNest. Reach us on WhatsApp with any questions.",
        deviceRequest: request._id,
      });
    } else if (status !== undefined) {
      return sendError(res, 400, "status must be completed or cancelled");
    }
    await request.save();
    sendSuccess(res, 200, "Request updated", {
      request: {
        ...(await customerView(request)),
        adminNotes: request.adminNotes,
        finalPrice: request.finalPrice ?? undefined,
        commission: request.commission ?? undefined,
        commissionStatus: request.commissionStatus,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/requests/{id}/match:
 *   post:
 *     summary: Match an open request again — e.g. after onboarding a vendor for that area
 *     description: Newly matched vendors are notified; vendors already matched aren't notified twice.
 *     tags: [Admin — Requests]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.added, data.matchedVendors
 */
router.post("/:id/match", verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Request not found");
    const request = await DeviceRequest.findById(req.params.id);
    if (!request) return sendError(res, 404, "Request not found");
    if (request.status !== "open") return sendError(res, 409, "Only open requests can be matched.");

    const already = new Set(request.matchedVendors.map(String));
    const fresh = (await findMatchingVendors(request)).filter((v) => !already.has(String(v._id)));
    request.matchedVendors.push(...fresh.map((v) => v._id));
    await request.save();
    await notify(
      fresh.map((v) => ({
        recipient: v._id,
        type: "device_request",
        title: `New ${request.type} request: ${request.deviceName}`,
        message: `A customer posted a ${request.type} request for "${request.deviceName}" in ${request.state}. Send your offer before it closes.`,
        deviceRequest: request._id,
      }))
    );
    sendSuccess(res, 200, "Matched again", { added: fresh.length, matchedVendors: request.matchedVendors.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
