// Smart vendor matching: which vendors see a customer request, how offers
// are ranked, and picking the winner (by the customer, or automatically
// when the request closes). Expiry is checked whenever a request is read
// and by POST /api/internal/tick, so no scheduled job is required.
const User = require("../models/User");
const InventoryItem = require("../models/Inventoryitem");
const DeviceRequest = require("../models/DeviceRequest");
const { notify, notifyAdmins } = require("./notify");
const { normalizeDeviceName } = require("./textParsing");
const { SUPPORT_WHATSAPP } = require("./supportFaq");

const MAX_MATCHED = 40;
// Emails cost free-tier quota; the best-ranked vendors get one, the rest
// see it in-app
const MAX_EMAILED = 10;

// Which kinds of vendor handle which requests
const vendorTypesFor = (type, category) => {
  if (type === "repair") return ["repairs"];
  if (type === "accessory" || category === "accessory") return ["accessories"];
  if (category === "phone") return ["phone_dealer"];
  if (category === "tablet" || category === "wearable") return ["phone_dealer", "gadgets"];
  return ["gadgets"];
};

// For sell requests the vendor is paying, so a higher offer is better
const higherIsBetter = (type) => type === "sell";

const brandWord = (deviceName) => String(deviceName || "").trim().split(/\s+/)[0].toLowerCase();

/** Approved vendors who should see this request, best first. */
const findMatchingVendors = async (request) => {
  const types = vendorTypesFor(request.type, request.category);
  // Vendors who signed up before vendor types existed were all phone dealers
  const typeClause = types.includes("phone_dealer")
    ? { $or: [{ "vendorProfile.vendorTypes": { $in: types } }, { "vendorProfile.vendorTypes": { $in: [null, []] } }] }
    : { "vendorProfile.vendorTypes": { $in: types } };
  const vendors = await User.find({
    $and: [
      { userType: "vendor", vendorVerified: true },
      typeClause,
      { $or: [{ "vendorProfile.states": request.state }, { "vendorProfile.states": { $in: [null, []] } }] },
      { _id: { $ne: request.customer } },
    ],
  }).select("name vendorProfile identityVerified");
  if (!vendors.length) return [];

  // Vendors holding a matching device in stock rank first for buy requests
  let stocked = new Set();
  if (request.type === "buy") {
    const key = normalizeDeviceName(request.deviceName);
    const items = await InventoryItem.find({ vendor: { $in: vendors.map((v) => v._id) }, status: "in_stock" }).select("vendor deviceName");
    stocked = new Set(items.filter((i) => normalizeDeviceName(i.deviceName).includes(key)).map((i) => String(i.vendor)));
  }
  const brand = brandWord(request.deviceName);
  const score = (v) => {
    const p = v.vendorProfile || {};
    let s = 0;
    if (stocked.has(String(v._id))) s += 4;
    if (p.states?.includes(request.state)) s += 2; // local beats nationwide
    if (p.brands?.some((b) => b.toLowerCase() === brand)) s += 1;
    if (request.repairServiceId && p.repairServices?.includes(request.repairServiceId)) s += 2;
    if (v.identityVerified) s += 1;
    return s;
  };
  return vendors
    .map((v) => ({ vendor: v, score: score(v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_MATCHED)
    .map((x) => x.vendor);
};

/** Deals each vendor has completed through requests — shown with offers. */
const completedDealsFor = async (vendorIds) => {
  const rows = await DeviceRequest.aggregate([
    { $match: { status: "completed", acceptedVendor: { $in: vendorIds } } },
    { $group: { _id: "$acceptedVendor", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
};

/**
 * Active offers best-first. The rule: best price wins (lowest, or highest
 * for sell requests); ties go to the vendor with more completed deals,
 * then the earlier offer.
 */
const rankOffers = (request, deals) => {
  const dir = higherIsBetter(request.type) ? -1 : 1;
  return request.offers
    .filter((o) => o.status === "active")
    .sort(
      (a, b) =>
        dir * (a.price - b.price) ||
        (deals.get(String(b.vendor)) || 0) - (deals.get(String(a.vendor)) || 0) ||
        a.createdAt - b.createdAt
    );
};

const whatsappFor = (request) =>
  `https://wa.me/${SUPPORT_WHATSAPP()}?text=${encodeURIComponent(
    `Hi TechNest, I've accepted an offer on my ${request.type} request for ${request.deviceName}. Ref: ${request.reference}`
  )}`;

/** Accepts one offer, declines the rest and tells everyone. Saves the request. */
const acceptOffer = async (request, offer, { auto = false } = {}) => {
  request.status = "accepted";
  request.acceptedOffer = offer._id;
  request.acceptedVendor = offer.vendor;
  request.acceptedAt = new Date();
  request.autoSelected = auto;
  for (const o of request.offers) {
    if (String(o._id) === String(offer._id)) o.status = "accepted";
    else if (o.status === "active") o.status = "declined";
  }
  await request.save();

  const losers = request.offers.filter((o) => o.status === "declined");
  await notify([
    {
      recipient: offer.vendor,
      type: "offer_accepted",
      title: `Your offer was accepted (${request.reference})`,
      message: `Your ₦${offer.price.toLocaleString()} offer on "${request.deviceName}" was accepted. TechNest will contact you to arrange it.`,
      deviceRequest: request._id,
    },
    ...losers.map((o) => ({
      recipient: o.vendor,
      type: "offer_update",
      title: `Another offer was chosen (${request.reference})`,
      message: `The customer went with another offer on "${request.deviceName}". Thanks for bidding.`,
      deviceRequest: request._id,
      email: false,
    })),
    {
      recipient: request.customer,
      type: "device_request",
      title: auto ? `We picked the best offer for you (${request.reference})` : `Offer accepted (${request.reference})`,
      message: `${offer.vendorName} — ₦${offer.price.toLocaleString()}${offer.eta ? `, ${offer.eta}` : ""}. TechNest will contact you on WhatsApp to arrange it.`,
      deviceRequest: request._id,
    },
  ]);
  await notifyAdmins({
    type: "admin_alert",
    title: `Request ${request.reference} needs arranging`,
    message: `${request.customerName}'s ${request.type} request for "${request.deviceName}" accepted ${offer.vendorName}'s ₦${offer.price.toLocaleString()} offer${auto ? " (auto-selected)" : ""}.`,
    deviceRequest: request._id,
  });
};

/**
 * Closes a request whose time is up: auto-picks the best offer when the
 * customer asked for that, otherwise marks it expired. Safe to call on
 * every read. Returns the up-to-date request.
 */
const settleIfExpired = async (request) => {
  if (request.status !== "open" || request.expiresAt > new Date()) return request;
  // Claim it first so two readers can't both settle it
  const claimed = await DeviceRequest.findOneAndUpdate(
    { _id: request._id, status: "open" },
    { $set: { status: "expired" } },
    { returnDocument: "after" }
  );
  if (!claimed) return (await DeviceRequest.findById(request._id)) || request;

  const deals = await completedDealsFor(claimed.offers.map((o) => o.vendor));
  const best = rankOffers(claimed, deals)[0];
  if (claimed.autoSelect && best) {
    await acceptOffer(claimed, best, { auto: true });
  } else {
    await notify({
      recipient: claimed.customer,
      type: "device_request",
      title: `Your request ${claimed.reference} has closed`,
      message: claimed.offers.some((o) => o.status === "active")
        ? `Your request for "${claimed.deviceName}" closed before you picked an offer. Post it again or reach us on WhatsApp.`
        : `No vendor made an offer on "${claimed.deviceName}" in time. Our team can help — reach us on WhatsApp.`,
      deviceRequest: claimed._id,
    });
  }
  return claimed;
};

module.exports = {
  MAX_EMAILED,
  vendorTypesFor,
  higherIsBetter,
  findMatchingVendors,
  completedDealsFor,
  rankOffers,
  acceptOffer,
  settleIfExpired,
  whatsappFor,
};
