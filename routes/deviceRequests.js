const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const DeviceRequest = require("../models/DeviceRequest");
const User = require("../models/User");
const { protect, restrictTo, requireVerified, requireVendorVerified } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { normalizeState } = require("../utils/nigeria");
const { parseImei, hashImei, findOpenStolenReport, recordStolenHit } = require("../utils/imei");
const { notify, notifyAdmins } = require("../utils/notify");
const {
  MAX_EMAILED,
  findMatchingVendors,
  completedDealsFor,
  rankOffers,
  acceptOffer,
  settleIfExpired,
  whatsappFor,
} = require("../utils/matching");
const router = express.Router();

const REPAIR_IDS = new Set(require("../data/repairs.json").map((r) => r.id));
const TYPES = ["buy", "sell", "swap", "repair", "accessory"];
const CATEGORIES = ["phone", "laptop", "tablet", "wearable", "gaming", "audio", "camera", "accessory", "other"];

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  handler: (req, res) => sendError(res, 429, "You've posted a lot of requests — please try again later."),
});

const isOurImage = (url) =>
  typeof url === "string" &&
  url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`);

const base = (r) => ({
  id: String(r._id),
  reference: r.reference,
  type: r.type,
  category: r.category,
  deviceName: r.deviceName,
  storage: r.storage || undefined,
  condition: r.condition || undefined,
  wantedDevice: r.wantedDevice || undefined,
  issue: r.issue || undefined,
  repairServiceId: r.repairServiceId || undefined,
  snapchatStatus: r.snapchatStatus,
  imeiLast4: r.imeiLast4 || undefined,
  description: r.description || undefined,
  images: r.images,
  budgetMin: r.budgetMin ?? undefined,
  budgetMax: r.budgetMax ?? undefined,
  state: r.state,
  city: r.city || undefined,
  autoSelect: r.autoSelect,
  expiresAt: r.expiresAt.toISOString(),
  status: r.status,
  createdAt: r.createdAt.toISOString(),
});

// The customer sees every live offer, best first, with the recommended one
// flagged — vendor names and track record, never their contacts
const customerView = async (r) => {
  const vendorIds = r.offers.map((o) => o.vendor);
  const [deals, vendors] = await Promise.all([
    completedDealsFor(vendorIds),
    User.find({ _id: { $in: vendorIds } }).select("identityVerified"),
  ]);
  const verified = new Set(vendors.filter((v) => v.identityVerified).map((v) => String(v._id)));
  const ranked = r.status === "open" ? rankOffers(r, deals) : r.offers.filter((o) => ["accepted", "declined"].includes(o.status));
  return {
    ...base(r),
    matchedVendors: r.matchedVendors.length,
    autoSelected: r.autoSelected || undefined,
    offers: ranked.map((o, i) => ({
      id: String(o._id),
      vendorName: o.vendorName,
      vendorVerified: verified.has(String(o.vendor)),
      vendorCompletedDeals: deals.get(String(o.vendor)) || 0,
      price: o.price,
      message: o.message || undefined,
      eta: o.eta || undefined,
      warrantyDays: o.warrantyDays,
      status: o.status,
      recommended: r.status === "open" && i === 0,
      createdAt: o.createdAt.toISOString(),
    })),
    whatsappUrl: r.status === "accepted" ? whatsappFor(r) : undefined,
  };
};

// Vendors bid blind: they see the request, how many offers exist, and only
// their own offer
const vendorView = (r, vendorId) => {
  const mine = r.offers.find((o) => String(o.vendor) === String(vendorId) && o.status !== "withdrawn");
  return {
    ...base(r),
    customerName: r.customerName.split(" ")[0],
    offerCount: r.offers.filter((o) => o.status === "active").length,
    myOffer: mine
      ? { id: String(mine._id), price: mine.price, message: mine.message || undefined, eta: mine.eta || undefined, warrantyDays: mine.warrantyDays, status: mine.status }
      : null,
    youWon: String(r.acceptedVendor) === String(vendorId) || undefined,
  };
};

const loadRequest = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    sendError(res, 404, "Request not found");
    return null;
  }
  const found = await DeviceRequest.findById(req.params.id);
  if (!found) {
    sendError(res, 404, "Request not found");
    return null;
  }
  return settleIfExpired(found);
};

/**
 * @swagger
 * /api/requests:
 *   post:
 *     summary: Post a request — it goes to matching vendors, who send offers
 *     description: >
 *       Vendors are matched by what they do (phone dealer, gadgets,
 *       accessories, repairs), the state they serve, brands, repair services
 *       and stock. The customer gets an automatic confirmation (in-app +
 *       email) saying how many vendors it went to. With `autoSelect: true`
 *       the best offer is accepted automatically when the request closes
 *       (best price, then most completed deals). For sell/swap, an optional
 *       `imei` is checked against stolen reports.
 *     tags: [Requests]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, category, deviceName, state]
 *             properties:
 *               type: { type: string, enum: [buy, sell, swap, repair, accessory] }
 *               category: { type: string, enum: [phone, laptop, tablet, wearable, gaming, audio, camera, accessory, other] }
 *               deviceName: { type: string, example: iPhone 13 Pro }
 *               storage: { type: string }
 *               condition: { type: string, description: "sell/swap: e.g. UK used, battery 88%, no scratches" }
 *               wantedDevice: { type: string, description: swap — required }
 *               issue: { type: string, description: repair — required }
 *               repairServiceId: { type: string, description: id from GET /api/repair-triage/services }
 *               snapchatStatus: { type: string, enum: [works, banned, unknown] }
 *               imei: { type: string, description: "sell/swap, optional" }
 *               description: { type: string }
 *               images: { type: array, maxItems: 6, items: { type: string } }
 *               budgetMin: { type: number }
 *               budgetMax: { type: number, description: "buy/repair/accessory: most you'll pay; sell: your asking price" }
 *               state: { type: string, example: Lagos }
 *               city: { type: string }
 *               autoSelect: { type: boolean }
 *               hours: { type: integer, description: "How long vendors have, 2–168 (default 72)" }
 *     responses:
 *       201:
 *         description: "data: { request, matchedVendors }"
 *       400:
 *         description: Missing or invalid fields
 *       409:
 *         description: The IMEI is reported stolen
 *   get:
 *     summary: Your requests, with offers
 *     tags: [Requests]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: data.requests
 */
router.post("/", protect, requireVerified, verifyCsrfToken, createLimiter, async (req, res, next) => {
  try {
    const b = req.body || {};
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

    if (!TYPES.includes(b.type)) return sendError(res, 400, "Choose what you want to do: buy, sell, swap, repair or accessory.");
    if (!CATEGORIES.includes(b.category)) return sendError(res, 400, "Choose a device category.");
    const deviceName = str(b.deviceName, 150);
    if (deviceName.length < 2) return sendError(res, 400, "Tell us the device (e.g. iPhone 13 Pro).");
    const state = normalizeState(b.state);
    if (!state) return sendError(res, 400, "Choose your state.");
    if (b.type === "swap" && !str(b.wantedDevice, 150)) return sendError(res, 400, "Tell us the device you want in exchange.");
    if (b.type === "repair" && !str(b.issue, 500)) return sendError(res, 400, "Describe what's wrong with the device.");
    const budgetMin = num(b.budgetMin);
    const budgetMax = num(b.budgetMax);
    if ([budgetMin, budgetMax].some((v) => v !== null && (!Number.isFinite(v) || v < 0)))
      return sendError(res, 400, "Budget must be an amount in naira.");
    if (budgetMin !== null && budgetMax !== null && budgetMin > budgetMax)
      return sendError(res, 400, "The minimum budget is higher than the maximum.");

    let imeiLast4 = null;
    if (["sell", "swap"].includes(b.type) && b.imei) {
      const parsed = parseImei(b.imei);
      if (parsed.error) return sendError(res, 400, parsed.error);
      const report = await findOpenStolenReport(hashImei(parsed.imei));
      if (report) {
        await recordStolenHit(report, "listing", req.user._id);
        return sendError(res, 409, "This device has been reported stolen, so it can't be offered. If you think this is a mistake, contact support.");
      }
      imeiLast4 = parsed.last4;
    }

    const hours = Math.min(168, Math.max(2, parseInt(b.hours) || 72));
    const request = new DeviceRequest({
      customer: req.user._id,
      customerName: req.user.name,
      type: b.type,
      category: b.category,
      deviceName,
      storage: str(b.storage, 30) || null,
      condition: str(b.condition, 300) || null,
      wantedDevice: b.type === "swap" ? str(b.wantedDevice, 150) : null,
      issue: b.type === "repair" ? str(b.issue, 500) : null,
      repairServiceId: REPAIR_IDS.has(b.repairServiceId) ? b.repairServiceId : null,
      snapchatStatus: ["works", "banned"].includes(b.snapchatStatus) ? b.snapchatStatus : "unknown",
      imeiLast4,
      description: str(b.description, 1000) || null,
      images: (Array.isArray(b.images) ? b.images : []).filter(isOurImage).slice(0, 6),
      budgetMin,
      budgetMax,
      state,
      city: str(b.city, 60) || null,
      autoSelect: b.autoSelect === true,
      expiresAt: new Date(Date.now() + hours * 3600 * 1000),
    });

    const vendors = await findMatchingVendors(request);
    request.matchedVendors = vendors.map((v) => v._id);
    await request.save();

    const what = `${request.type} request for "${deviceName}"${request.city ? ` in ${request.city}` : ""}, ${state}`;
    await notify(
      vendors.map((v, i) => ({
        recipient: v._id,
        type: "device_request",
        title: `New ${request.type} request: ${deviceName}`,
        message: `A customer posted a ${what}. Send your offer before ${request.expiresAt.toUTCString().slice(0, 22)} GMT.`,
        deviceRequest: request._id,
        email: i < MAX_EMAILED,
      }))
    );

    const closes = request.expiresAt.toUTCString().slice(0, 22) + " GMT";
    await notify({
      recipient: req.user._id,
      type: "device_request",
      title: `We've got your request (${request.reference})`,
      message: vendors.length
        ? `We sent your ${request.type} request for "${deviceName}" to ${vendors.length} vendor${vendors.length === 1 ? "" : "s"}${vendors.some((v) => v.vendorProfile?.states?.includes(state)) ? ` in ${state}` : ""}. Offers will show up here and by email. ${request.autoSelect ? `We'll pick the best offer for you when it closes (${closes}).` : `Pick one before it closes (${closes}).`}`
        : `We're finding a vendor for your ${request.type} request for "${deviceName}" in ${state}. Our team will contact you on WhatsApp.`,
      deviceRequest: request._id,
    });
    if (!vendors.length)
      await notifyAdmins({
        type: "admin_alert",
        title: `No vendor matched ${request.reference}`,
        message: `${req.user.name}'s ${what} didn't match any approved vendor. Find one or onboard one, then use "match again".`,
        deviceRequest: request._id,
      });

    sendSuccess(res, 201, "Request posted", {
      request: await customerView(request),
      matchedVendors: vendors.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", protect, async (req, res, next) => {
  try {
    const found = await DeviceRequest.find({ customer: req.user._id }).sort({ createdAt: -1 }).limit(100);
    const requests = [];
    for (const r of found) requests.push(await customerView(await settleIfExpired(r)));
    sendSuccess(res, 200, "Requests fetched", { requests });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/requests/for-vendor:
 *   get:
 *     summary: Requests matched to the logged-in vendor
 *     tags: [Requests]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, accepted, completed, expired, cancelled], default: open }
 *     responses:
 *       200:
 *         description: "data.requests — each with customerName (first name only), offerCount, myOffer and youWon"
 */
router.get("/for-vendor", protect, restrictTo("vendor"), requireVendorVerified, async (req, res, next) => {
  try {
    const status = ["open", "accepted", "completed", "expired", "cancelled"].includes(req.query.status) ? req.query.status : "open";
    const found = await DeviceRequest.find({ matchedVendors: req.user._id, status }).sort({ createdAt: -1 }).limit(100);
    const requests = [];
    for (const r of found) {
      const fresh = await settleIfExpired(r);
      if (fresh.status === status) requests.push(vendorView(fresh, req.user._id));
    }
    sendSuccess(res, 200, "Requests fetched", { requests });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/requests/{id}:
 *   get:
 *     summary: One request — the customer sees all offers, a matched vendor sees only their own
 *     tags: [Requests]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.request
 *       404:
 *         description: Not found (or not yours)
 */
router.get("/:id", protect, async (req, res, next) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    const me = String(req.user._id);
    if (String(request.customer) === me || req.user.userType === "admin")
      return sendSuccess(res, 200, "Request fetched", { request: await customerView(request) });
    if (request.matchedVendors.some((v) => String(v) === me))
      return sendSuccess(res, 200, "Request fetched", { request: vendorView(request, me) });
    sendError(res, 404, "Request not found");
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/requests/{id}/offers:
 *   post:
 *     summary: Vendor makes (or updates) their offer on a request matched to them
 *     description: >
 *       `price` means: buy/accessory — what the customer pays; repair — the
 *       repair cost; sell — what you'll pay for the device; swap — the top-up
 *       the customer pays (0 for an even swap). One offer per vendor; sending
 *       again updates it. The customer is notified.
 *     tags: [Requests]
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
 *             required: [price]
 *             properties:
 *               price: { type: number }
 *               message: { type: string, maxLength: 500 }
 *               eta: { type: string, example: Same day }
 *               warrantyDays: { type: integer }
 *     responses:
 *       201:
 *         description: data.request (vendor view)
 *       404:
 *         description: Not found or not matched to you
 *       409:
 *         description: Request is closed
 *   delete:
 *     summary: Vendor withdraws their offer
 *     tags: [Requests]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Withdrawn
 */
router.post("/:id/offers", protect, restrictTo("vendor"), requireVendorVerified, verifyCsrfToken, async (req, res, next) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    const me = String(req.user._id);
    if (!request.matchedVendors.some((v) => String(v) === me)) return sendError(res, 404, "Request not found");
    if (request.status !== "open") return sendError(res, 409, "This request is closed.");

    const price = Number(req.body.price);
    if (!Number.isFinite(price) || price < 0 || price > 100_000_000) return sendError(res, 400, "Enter your price in naira.");
    const warrantyDays = Math.min(730, Math.max(0, parseInt(req.body.warrantyDays) || 0));
    const fields = {
      price: Math.round(price),
      message: typeof req.body.message === "string" ? req.body.message.trim().slice(0, 500) || null : null,
      eta: typeof req.body.eta === "string" ? req.body.eta.trim().slice(0, 60) || null : null,
      warrantyDays,
      status: "active",
    };

    const existing = request.offers.find((o) => String(o.vendor) === me);
    const isFirstOffer = !request.offers.some((o) => o.status === "active");
    if (existing) existing.set(fields);
    else request.offers.push({ ...fields, vendor: req.user._id, vendorName: req.user.vendorProfile?.businessName || req.user.name });
    await request.save();

    await notify({
      recipient: request.customer,
      type: "offer_received",
      title: existing ? `An offer was updated (${request.reference})` : `New offer on your request (${request.reference})`,
      message: `${req.user.vendorProfile?.businessName || req.user.name} offered ₦${fields.price.toLocaleString()} for "${request.deviceName}"${fields.eta ? ` (${fields.eta})` : ""}.`,
      deviceRequest: request._id,
      // Email the first offer; later ones are in-app so the inbox isn't flooded
      email: isFirstOffer && !existing,
    });

    sendSuccess(res, existing ? 200 : 201, existing ? "Offer updated" : "Offer sent", { request: vendorView(request, me) });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/offers", protect, restrictTo("vendor"), verifyCsrfToken, async (req, res, next) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    const mine = request.offers.find((o) => String(o.vendor) === String(req.user._id) && o.status === "active");
    if (!mine) return sendError(res, 404, "You have no active offer on this request.");
    if (request.status !== "open") return sendError(res, 409, "This request is closed.");
    mine.status = "withdrawn";
    await request.save();
    sendSuccess(res, 200, "Offer withdrawn", { request: vendorView(request, req.user._id) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/requests/{id}/offers/{offerId}/accept:
 *   post:
 *     summary: Customer accepts an offer
 *     description: Other offers are declined, the vendor and TechNest are told, and data.request.whatsappUrl opens a chat with TechNest to arrange it.
 *     tags: [Requests]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: offerId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.request
 *       409:
 *         description: Request closed or offer no longer active
 */
router.post("/:id/offers/:offerId/accept", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    if (String(request.customer) !== String(req.user._id)) return sendError(res, 404, "Request not found");
    if (request.status !== "open") return sendError(res, 409, "This request is closed.");
    const offer = request.offers.id(req.params.offerId);
    if (!offer || offer.status !== "active") return sendError(res, 409, "That offer is no longer available.");

    // Claim it atomically so a double tap can't accept two offers
    const claimed = await DeviceRequest.findOneAndUpdate(
      { _id: request._id, status: "open" },
      { $set: { status: "accepted" } },
      { returnDocument: "after" }
    );
    if (!claimed) return sendError(res, 409, "This request is closed.");
    await acceptOffer(claimed, claimed.offers.id(offer._id));
    sendSuccess(res, 200, "Offer accepted", { request: await customerView(claimed) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/requests/{id}/cancel:
 *   post:
 *     summary: Customer cancels an open request
 *     tags: [Requests]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Cancelled
 *       409:
 *         description: Not open
 */
router.post("/:id/cancel", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const request = await loadRequest(req, res);
    if (!request) return;
    if (String(request.customer) !== String(req.user._id)) return sendError(res, 404, "Request not found");
    if (request.status !== "open") return sendError(res, 409, "Only open requests can be cancelled.");
    request.status = "cancelled";
    for (const o of request.offers) if (o.status === "active") o.status = "declined";
    await request.save();
    await notify(
      request.offers.map((o) => ({
        recipient: o.vendor,
        type: "offer_update",
        title: `Request ${request.reference} was cancelled`,
        message: `The customer cancelled their request for "${request.deviceName}".`,
        deviceRequest: request._id,
        email: false,
      }))
    );
    sendSuccess(res, 200, "Request cancelled", { request: await customerView(request) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.customerView = customerView;
