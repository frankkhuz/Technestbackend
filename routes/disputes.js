const express = require("express");
const mongoose = require("mongoose");
const Dispute = require("../models/Dispute");
const DeviceRequest = require("../models/DeviceRequest");
const Transaction = require("../models/Transaction");
const OrderRequest = require("../models/OrderRequest");
const { protect, restrictTo, requireVerified } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { notify, notifyAdmins } = require("../utils/notify");
const router = express.Router();

// Policy defaults — change here
const DISPUTE_WINDOW_DAYS = 7;
const REASONS = ["not_as_described", "faulty", "not_delivered", "wrong_item", "stolen_or_locked", "other"];
const RESOLUTIONS = ["refund", "partial_refund", "replacement", "repair", "return_and_refund", "no_action"];

const isOurImage = (url) =>
  typeof url === "string" && url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`);
const cleanEvidence = (list) => (Array.isArray(list) ? list.filter(isOurImage).slice(0, 6) : []);

/**
 * The deal behind a dispute, if this user is in it and it's still open to
 * complaints. @returns {{ against, label } | { status, error }}
 */
const resolveDeal = async (user, type, id) => {
  if (!mongoose.isValidObjectId(id)) return { status: 404, error: "Deal not found" };
  const me = String(user._id);
  const notFound = { status: 404, error: "Deal not found" };
  let against = null, label, completedAt = null;

  if (type === "device_request") {
    const r = await DeviceRequest.findById(id);
    if (!r || ![String(r.customer), String(r.acceptedVendor)].includes(me)) return notFound;
    if (!["accepted", "completed"].includes(r.status)) return { status: 409, error: "You can only raise a dispute on an accepted or completed deal." };
    against = String(r.customer) === me ? r.acceptedVendor : r.customer;
    [label, completedAt] = [`${r.deviceName} — ${r.type} request ${r.reference}`, r.status === "completed" ? r.completedAt : null];
  } else if (type === "transaction") {
    const txn = await Transaction.findById(id);
    if (!txn || ![String(txn.buyer), String(txn.seller)].includes(me)) return notFound;
    if (!["accepted", "completed"].includes(txn.status)) return { status: 409, error: "You can only raise a dispute on an accepted or completed deal." };
    against = String(txn.buyer) === me ? txn.seller : txn.buyer;
    [label, completedAt] = [`${txn.listingDeviceName} — ${txn.type}`, txn.status === "completed" ? txn.updatedAt : null];
  } else if (type === "order_request") {
    const o = await OrderRequest.findById(id).populate("listing", "owner deviceName");
    if (!o || String(o.buyer) !== me) return notFound;
    if (!["in_progress", "completed"].includes(o.status)) return { status: 409, error: "You can only raise a dispute on an order that's being handled or completed." };
    // Catalog orders are TechNest's own — there's no other user to answer
    against = o.listing?.owner || null;
    [label, completedAt] = [`Order ${o.reference} — ${o.items.map((i) => i.name).join(", ")}`, o.completedAt];
  } else {
    return { status: 400, error: "source.type must be device_request, transaction or order_request" };
  }
  if (completedAt && Date.now() - completedAt > DISPUTE_WINDOW_DAYS * 864e5)
    return { status: 409, error: `Disputes can be raised up to ${DISPUTE_WINDOW_DAYS} days after a deal completes. Contact support.` };
  return { against, label };
};

// A seller isn't paid out while a dispute about their sale is open
const holdPayout = (d) =>
  d.source.type === "order_request" &&
  OrderRequest.updateOne({ _id: d.source.id, payoutStatus: "pending" }, { payoutStatus: "on_hold" });
const releasePayout = (d) =>
  d.source.type === "order_request" &&
  OrderRequest.updateOne(
    { _id: d.source.id, payoutStatus: "on_hold" },
    { payoutStatus: ["refund", "return_and_refund"].includes(d.resolution) ? "cancelled" : "pending" }
  );

const roleOf = (d, user) =>
  user.userType === "admin" ? "staff" : String(d.raisedBy) === String(user._id) ? "raiser" : String(d.against) === String(user._id) ? "respondent" : null;

const toClient = (d) => ({
  id: String(d._id),
  reference: d.reference,
  source: { type: d.source.type, id: String(d.source.id), label: d.source.label },
  reason: d.reason,
  description: d.description,
  evidence: d.evidence,
  status: d.status,
  resolution: d.resolution || undefined,
  resolutionNote: d.resolutionNote || undefined,
  refundAmount: d.refundAmount ?? undefined,
  messages: d.messages.map((m) => ({ role: m.role, text: m.text, evidence: m.evidence, at: m.createdAt })),
  createdAt: d.createdAt,
  resolvedAt: d.resolvedAt || undefined,
});

const tellParties = (d, title, message, except) =>
  notify(
    [d.raisedBy, d.against]
      .filter((u) => u && String(u) !== String(except))
      .map((recipient) => ({ recipient, type: "dispute_update", title, message }))
  );

/**
 * @swagger
 * /api/disputes:
 *   post:
 *     summary: Raise a dispute on a deal (e.g. device not as described)
 *     description: >
 *       Either side of an accepted/completed request or buy/sell/swap, or the
 *       buyer of a WhatsApp order, up to 7 days after completion. The other
 *       side and TechNest staff are notified; a listing's seller payout is
 *       held until it's settled. Evidence: up to 6 Cloudinary photo URLs.
 *     tags: [Disputes]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source, reason, description]
 *             properties:
 *               source:
 *                 type: object
 *                 properties:
 *                   type: { type: string, enum: [device_request, transaction, order_request] }
 *                   id: { type: string }
 *               reason: { type: string, enum: [not_as_described, faulty, not_delivered, wrong_item, stolen_or_locked, other] }
 *               description: { type: string, maxLength: 2000 }
 *               evidence: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: data.dispute
 *       409:
 *         description: Deal not eligible, past the window, or already disputed
 *   get:
 *     summary: Disputes you raised or that are about you
 *     tags: [Disputes]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: data.disputes
 */
router.post("/", protect, requireVerified, verifyCsrfToken, async (req, res, next) => {
  try {
    const { type, id } = req.body.source || {};
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 2000) : "";
    if (!REASONS.includes(req.body.reason)) return sendError(res, 400, `reason must be one of: ${REASONS.join(", ")}`);
    if (description.length < 10) return sendError(res, 400, "Tell us what went wrong (a sentence or two).");
    const deal = await resolveDeal(req.user, type, id);
    if (deal.error) return sendError(res, deal.status, deal.error);
    if (await Dispute.exists({ raisedBy: req.user._id, "source.type": type, "source.id": id, status: { $in: ["open", "investigating"] } }))
      return sendError(res, 409, "You already have an open dispute on this deal.");

    const dispute = await Dispute.create({
      raisedBy: req.user._id,
      against: deal.against,
      source: { type, id, label: deal.label },
      reason: req.body.reason,
      description,
      evidence: cleanEvidence(req.body.evidence),
    });
    await holdPayout(dispute);
    if (dispute.against)
      await notify({
        recipient: dispute.against,
        type: "dispute_update",
        title: `A dispute was raised (${dispute.reference})`,
        message: `There's a complaint about ${deal.label}: "${description.slice(0, 200)}". Reply on the dispute — TechNest will look into it.`,
      });
    await notifyAdmins({
      type: "admin_alert",
      title: `New dispute ${dispute.reference}`,
      message: `${req.user.name}: ${req.body.reason.replace(/_/g, " ")} — ${deal.label}.`,
    });
    sendSuccess(res, 201, "Dispute raised — we'll be in touch", { dispute: toClient(dispute) });
  } catch (err) {
    next(err);
  }
});

router.get("/", protect, async (req, res, next) => {
  try {
    const disputes = await Dispute.find({ $or: [{ raisedBy: req.user._id }, { against: req.user._id }] }).sort({ createdAt: -1 }).limit(100);
    sendSuccess(res, 200, "Disputes fetched", {
      disputes: disputes.map((d) => ({ ...toClient(d), yourRole: roleOf(d, req.user) })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/disputes/admin:
 *   get:
 *     summary: Admin — disputes to handle, oldest open first
 *     tags: [Disputes]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, investigating, resolved, rejected] }
 *     responses:
 *       200:
 *         description: data.disputes (with raisedBy / against names and emails), data.counts
 */
router.get("/admin", protect, restrictTo("admin"), async (req, res, next) => {
  try {
    const filter = ["open", "investigating", "resolved", "rejected"].includes(req.query.status) ? { status: req.query.status } : {};
    const [disputes, counts] = await Promise.all([
      Dispute.find(filter).populate("raisedBy", "name email").populate("against", "name email vendorProfile.businessName").sort({ createdAt: 1 }).limit(200),
      Dispute.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    sendSuccess(res, 200, "Disputes fetched", {
      disputes: disputes.map((d) => ({ ...toClient(d), raisedBy: d.raisedBy, against: d.against })),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/disputes/{id}:
 *   get:
 *     summary: One dispute, with its messages (the two sides and staff only)
 *     tags: [Disputes]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.dispute
 * /api/disputes/{id}/messages:
 *   post:
 *     summary: Add a message (and photos) to a dispute
 *     tags: [Disputes]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text]
 *             properties:
 *               text: { type: string, maxLength: 1000 }
 *               evidence: { type: array, items: { type: string } }
 *     responses:
 *       201:
 *         description: data.dispute
 *       409:
 *         description: Dispute is closed
 */
// The dispute and the viewer's part in it, or answers 404 and returns null
const loadForUser = async (req, res) => {
  const d = mongoose.isValidObjectId(req.params.id) ? await Dispute.findById(req.params.id) : null;
  const role = d && roleOf(d, req.user);
  if (!role) {
    sendError(res, 404, "Dispute not found");
    return null;
  }
  return { d, role };
};

router.get("/:id", protect, async (req, res, next) => {
  try {
    const found = await loadForUser(req, res);
    if (found) sendSuccess(res, 200, "Dispute fetched", { dispute: { ...toClient(found.d), yourRole: found.role } });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/messages", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const found = await loadForUser(req, res);
    if (!found) return;
    const { d, role } = found;
    if (!["open", "investigating"].includes(d.status)) return sendError(res, 409, "This dispute is closed.");
    const text = typeof req.body.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
    if (!text) return sendError(res, 400, "Write a message.");
    d.messages.push({ author: req.user._id, role, text, evidence: cleanEvidence(req.body.evidence) });
    await d.save();
    const who = role === "staff" ? "TechNest" : role === "raiser" ? "The buyer" : "The other side";
    await tellParties(d, `New message on dispute ${d.reference}`, `${who}: "${text.slice(0, 200)}"`, req.user._id);
    if (role !== "staff")
      await notifyAdmins({ type: "admin_alert", title: `Reply on dispute ${d.reference}`, message: text.slice(0, 300), email: false });
    sendSuccess(res, 201, "Message added", { dispute: { ...toClient(d), yourRole: role } });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/disputes/admin/{id}:
 *   patch:
 *     summary: Admin — move a dispute along or decide it
 *     description: >
 *       `resolved` needs a `resolution`. A refund or return-and-refund cancels
 *       a held seller payout; any other outcome releases it. Refunds
 *       themselves are paid by staff outside the app (record the amount).
 *     tags: [Disputes]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [investigating, resolved, rejected] }
 *               resolution: { type: string, enum: [refund, partial_refund, replacement, repair, return_and_refund, no_action] }
 *               resolutionNote: { type: string }
 *               refundAmount: { type: number }
 *     responses:
 *       200:
 *         description: data.dispute
 *       409:
 *         description: Already closed
 */
router.patch("/admin/:id", protect, restrictTo("admin"), verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Dispute not found");
    const d = await Dispute.findById(req.params.id);
    if (!d) return sendError(res, 404, "Dispute not found");
    if (!["open", "investigating"].includes(d.status)) return sendError(res, 409, "This dispute is already closed.");
    const { status } = req.body;
    if (!["investigating", "resolved", "rejected"].includes(status)) return sendError(res, 400, "status must be investigating, resolved or rejected");
    if (status === "resolved" && !RESOLUTIONS.includes(req.body.resolution))
      return sendError(res, 400, `A resolved dispute needs a resolution: ${RESOLUTIONS.join(", ")}`);
    const refund = req.body.refundAmount === undefined || req.body.refundAmount === null ? null : Number(req.body.refundAmount);
    if (refund !== null && (!Number.isFinite(refund) || refund < 0)) return sendError(res, 400, "refundAmount must be an amount in naira.");

    d.status = status;
    d.handledBy = req.user._id;
    if (status !== "investigating") {
      d.resolution = status === "resolved" ? req.body.resolution : "no_action";
      d.resolutionNote = typeof req.body.resolutionNote === "string" ? req.body.resolutionNote.slice(0, 1000) : null;
      d.refundAmount = refund;
      d.resolvedAt = new Date();
    }
    await d.save();
    if (status !== "investigating") await releasePayout(d);

    const outcome = {
      investigating: "TechNest is looking into it and may contact you.",
      resolved: `Outcome: ${String(d.resolution).replace(/_/g, " ")}${d.refundAmount ? ` (₦${d.refundAmount.toLocaleString()})` : ""}.${d.resolutionNote ? ` ${d.resolutionNote}` : ""}`,
      rejected: `TechNest closed it without action.${d.resolutionNote ? ` ${d.resolutionNote}` : ""}`,
    }[status];
    await tellParties(d, `Dispute ${d.reference}: ${status}`, outcome.slice(0, 500));
    sendSuccess(res, 200, "Dispute updated", { dispute: toClient(d) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
