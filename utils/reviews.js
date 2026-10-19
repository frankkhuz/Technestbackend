// Ratings: who can review whom (only the people in a completed deal), and
// the averages shown on offers, the vendor directory and used in matching.
const mongoose = require("mongoose");
const Review = require("../models/Review");
const DeviceRequest = require("../models/DeviceRequest");
const Transaction = require("../models/Transaction");
const OrderRequest = require("../models/OrderRequest");

const REVIEW_WINDOW_DAYS = 30;

/** Average rating and count per user, visible reviews only. */
const ratingsFor = async (userIds) => {
  const ids = [...new Set(userIds.filter(Boolean).map(String))].map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return new Map();
  const rows = await Review.aggregate([
    { $match: { subject: { $in: ids }, status: "visible" } },
    { $group: { _id: "$subject", average: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { average: Math.round(r.average * 10) / 10, count: r.count }]));
};

const recent = () => new Date(Date.now() - REVIEW_WINDOW_DAYS * 864e5);

/**
 * The deal behind a review, if this user may review it.
 * @returns {{ subject, label } | { status, error }}
 */
const resolveDeal = async (user, type, id) => {
  if (!mongoose.isValidObjectId(id)) return { status: 404, error: "Deal not found" };
  const me = String(user._id);
  let subject = null, label = null, completedAt = null;

  if (type === "device_request") {
    const r = await DeviceRequest.findById(id);
    if (!r || String(r.customer) !== me) return { status: 404, error: "Deal not found" };
    if (r.status !== "completed") return { status: 409, error: "You can review once the deal is completed." };
    [subject, label, completedAt] = [r.acceptedVendor, `${r.deviceName} — ${r.type} request`, r.completedAt];
  } else if (type === "transaction") {
    const txn = await Transaction.findById(id);
    if (!txn || ![String(txn.buyer), String(txn.seller)].includes(me)) return { status: 404, error: "Deal not found" };
    if (txn.status !== "completed") return { status: 409, error: "You can review once the deal is completed." };
    subject = String(txn.buyer) === me ? txn.seller : txn.buyer;
    [label, completedAt] = [`${txn.listingDeviceName} — ${txn.type}`, txn.updatedAt];
  } else if (type === "order_request") {
    const o = await OrderRequest.findById(id).populate("listing", "owner deviceName");
    if (!o || String(o.buyer) !== me || !o.listing) return { status: 404, error: "Deal not found" };
    if (o.status !== "completed") return { status: 409, error: "You can review once the deal is completed." };
    [subject, label, completedAt] = [o.listing.owner, `${o.listing.deviceName} — bought through TechNest`, o.completedAt];
  } else {
    return { status: 400, error: "source.type must be device_request, transaction or order_request" };
  }
  if (!subject) return { status: 409, error: "There's nobody to review on this deal." };
  if (completedAt && completedAt < recent()) return { status: 409, error: `Reviews close ${REVIEW_WINDOW_DAYS} days after the deal.` };
  return { subject, label };
};

/** Completed deals this user can still review. */
const reviewableDeals = async (user) => {
  const since = recent();
  const [requests, txns, orders, done] = await Promise.all([
    DeviceRequest.find({ customer: user._id, status: "completed", completedAt: { $gte: since } }).populate("acceptedVendor", "name vendorProfile.businessName"),
    Transaction.find({ $or: [{ buyer: user._id }, { seller: user._id }], status: "completed", updatedAt: { $gte: since } }),
    OrderRequest.find({ buyer: user._id, status: "completed", kind: "listing", completedAt: { $gte: since } }).populate({ path: "listing", select: "deviceName owner", populate: { path: "owner", select: "name" } }),
    Review.find({ author: user._id }).select("source"),
  ]);
  const reviewed = new Set(done.map((r) => `${r.source.type}:${r.source.id}`));
  const me = String(user._id);
  return [
    ...requests.map((r) => ({ type: "device_request", id: String(r._id), subject: r.acceptedVendor && { id: String(r.acceptedVendor._id), name: r.acceptedVendor.vendorProfile?.businessName || r.acceptedVendor.name }, label: `${r.deviceName} — ${r.type} request`, completedAt: r.completedAt })),
    ...txns.map((t) => {
      const iAmBuyer = String(t.buyer) === me;
      return { type: "transaction", id: String(t._id), subject: { id: String(iAmBuyer ? t.seller : t.buyer), name: iAmBuyer ? t.sellerName : t.buyerName }, label: `${t.listingDeviceName} — ${t.type}`, completedAt: t.updatedAt };
    }),
    ...orders.map((o) => ({ type: "order_request", id: String(o._id), subject: o.listing?.owner && { id: String(o.listing.owner._id), name: o.listing.owner.name }, label: `${o.listing?.deviceName} — bought through TechNest`, completedAt: o.completedAt })),
  ].filter((d) => d.subject && !reviewed.has(`${d.type}:${d.id}`));
};

module.exports = { REVIEW_WINDOW_DAYS, ratingsFor, resolveDeal, reviewableDeals };
