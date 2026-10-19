const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const Listing = require("../models/Listing");
const Transaction = require("../models/Transaction");
const Order = require("../models/Order");
const OrderRequest = require("../models/OrderRequest");
const DeviceRequest = require("../models/DeviceRequest");
const Review = require("../models/Review");
const Dispute = require("../models/Dispute");
const Notification = require("../models/Notification");
const StolenReport = require("../models/StolenReport");
const PayoutAccount = require("../models/PayoutAccount");
const InventoryItem = require("../models/Inventoryitem");
const GadgetConversation = require("../models/GadgetConversation");
const cloudinary = require("../config/cloudinary");
const { protect } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { UNSUBSCRIBE_TYPES, unsubscribeSignature } = require("../utils/email");
const router = express.Router();

const sensitiveLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: (req, res) => sendError(res, 429, "Too many attempts — please try again in an hour."),
});

/**
 * @swagger
 * /api/me:
 *   get:
 *     summary: Get the current logged-in user's info
 *     tags: [Me]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: User info fetched
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *   delete:
 *     summary: Delete your account (Nigeria Data Protection Act — right to erasure)
 *     description: >
 *       Needs the password. Personal details are wiped and the account is
 *       anonymised; records of past deals stay (without your name) because
 *       the other side and TechNest's accounts need them. Open listings,
 *       requests, offers and orders are closed, and you're signed out
 *       everywhere. Refused while you owe commission or have an open dispute.
 *     tags: [Me]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Account deleted
 *       401:
 *         description: Wrong password
 *       409:
 *         description: Something must be settled first (message says what)
 */
router.get("/", protect, (req, res) => {
  sendSuccess(res, 200, "User fetched", {
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    userType: req.user.userType,
    isVerified: req.user.isVerified,
    createdAt: req.user.createdAt,
    vendorVerified: req.user.vendorVerified,
    vendorProfile: req.user.vendorProfile,
    identityVerified: req.user.identityVerified,
    identityStatus: req.user.identity?.status || "none",
    phone: req.user.phone,
    phoneVerified: req.user.phoneVerified,
    emailPrefs: {
      notifications: req.user.emailPrefs?.notifications !== false,
      announcements: req.user.emailPrefs?.announcements !== false,
    },
  });
});

router.delete("/", protect, verifyCsrfToken, sensitiveLimiter, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.userType === "admin") return sendError(res, 409, "Admin accounts can't be deleted from the app — ask another admin.");
    if (!(await user.matchPassword(String(req.body?.password || "")))) return sendError(res, 401, "That password isn't right.");

    // Nobody deletes their way out of a debt or a complaint
    if (await DeviceRequest.exists({ acceptedVendor: user._id, commissionStatus: "due" }))
      return sendError(res, 409, "You still owe TechNest commission on a completed request. Settle it first, then delete your account.");
    if (await Dispute.exists({ $or: [{ raisedBy: user._id }, { against: user._id }], status: { $in: ["open", "investigating"] } }))
      return sendError(res, 409, "You have an open dispute. It needs to be settled before you can delete your account.");

    // Close everything still open
    await Promise.all([
      Listing.updateMany({ owner: user._id, status: { $in: ["active", "pending_review", "expired", "rejected"] } }, { status: "removed", rejectionReason: "Seller deleted their account." }),
      DeviceRequest.updateMany({ customer: user._id, status: "open" }, { status: "cancelled" }),
      DeviceRequest.updateMany({ "offers.vendor": user._id, status: "open" }, { $set: { "offers.$[o].status": "withdrawn" } }, { arrayFilters: [{ "o.vendor": user._id, "o.status": "active" }] }),
      Transaction.updateMany({ $or: [{ buyer: user._id }, { seller: user._id }], status: { $in: ["pending", "accepted"] } }, { status: "cancelled", cancelledBy: user._id }),
      OrderRequest.updateMany({ buyer: user._id, status: { $in: ["new", "in_progress"] } }, { status: "cancelled", adminNotes: "Buyer deleted their account." }),
      InventoryItem.deleteMany({ vendor: user._id }),
      PayoutAccount.deleteMany({ user: user._id }),
      GadgetConversation.deleteMany({ user: user._id }),
      Notification.deleteMany({ recipient: user._id }),
    ]);

    // Past records stay for the other side and TechNest's accounts, but
    // without anything that identifies the person
    const gone = "Deleted user";
    await Promise.all([
      Listing.updateMany({ owner: user._id }, { userName: gone, userPhone: "-", imeiPhoto: null }),
      Transaction.updateMany({ buyer: user._id }, { buyerName: gone, buyerPhone: null }),
      Transaction.updateMany({ seller: user._id }, { sellerName: gone }),
      OrderRequest.updateMany({ buyer: user._id }, { buyerName: gone, buyerPhone: "-", buyerEmail: null, note: null, "delivery.address": null }),
      Order.updateMany({ buyer: user._id }, { buyerName: gone, buyerEmail: "deleted@deleted.technest.invalid", buyerPhone: "-", deliveryAddress: "-" }),
      DeviceRequest.updateMany({ customer: user._id }, { customerName: gone }),
      DeviceRequest.updateMany({ "offers.vendor": user._id }, { $set: { "offers.$[o].vendorName": gone } }, { arrayFilters: [{ "o.vendor": user._id }] }),
      Review.updateMany({ author: user._id }, { authorName: gone }),
    ]);

    // Private uploads (ID, selfie, CAC certificate) — best effort
    const privateIds = [user.identity?.idDocumentId, user.identity?.selfieId, user.vendorDocuments?.cacCertificateId].filter(Boolean);
    for (const id of privateIds)
      cloudinary.uploader.destroy(id, { type: "authenticated", invalidate: true }).catch((err) => console.error(`Couldn't delete ${id}:`, err.message));

    Object.assign(user, {
      name: "Deleted user",
      email: `deleted-${user._id}@deleted.technest.invalid`,
      password: crypto.randomBytes(32).toString("hex"),
      phone: null,
      phoneVerified: false,
      phoneVerifiedAt: null,
      phoneVerifiedVia: null,
      vendorVerified: false,
      identityVerified: false,
      emailPrefs: { notifications: false, announcements: false },
      deletedAt: new Date(),
      tokenVersion: (user.tokenVersion || 0) + 1,
    });
    for (const f of ["phoneVerification", "identity", "vendorProfile", "vendorDocuments", "verificationToken", "verificationTokenExpires", "passwordResetToken", "passwordResetExpires"])
      user.set(f, undefined);
    await user.save();

    for (const c of ["accessToken", "refreshToken", "csrfToken"]) res.clearCookie(c);
    sendSuccess(res, 200, "Your account has been deleted");
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/me/export:
 *   get:
 *     summary: Download everything TechNest holds about you (JSON file)
 *     tags: [Me]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: A JSON file download
 */
router.get("/export", protect, sensitiveLimiter, async (req, res, next) => {
  try {
    const me = req.user._id;
    const strip = (doc) => {
      const o = doc.toObject ? doc.toObject() : doc;
      delete o.imeiHash;
      return o;
    };
    const profile = (await User.findById(me).select("-password -tokenVersion -verificationToken -verificationTokenExpires -passwordResetToken -passwordResetExpires -phoneVerification.codeHash")).toObject();
    const [listings, transactions, orders, orderRequests, myRequests, myOffers, reviewsWritten, reviewsAboutMe, disputes, notifications, stolenReports, payoutAccount, inventory, conversations] = await Promise.all([
      Listing.find({ owner: me }),
      Transaction.find({ $or: [{ buyer: me }, { seller: me }] }),
      Order.find({ buyer: me }),
      OrderRequest.find({ buyer: me }),
      DeviceRequest.find({ customer: me }),
      // As a vendor: only your own offers on other people's requests
      DeviceRequest.find({ "offers.vendor": me }).select("reference type deviceName status offers createdAt"),
      Review.find({ author: me }),
      Review.find({ subject: me }),
      Dispute.find({ $or: [{ raisedBy: me }, { against: me }] }),
      Notification.find({ recipient: me }).sort({ createdAt: -1 }).limit(1000),
      StolenReport.find({ reporter: me }),
      PayoutAccount.findOne({ user: me }),
      InventoryItem.find({ vendor: me }),
      GadgetConversation.find({ user: me }),
    ]);
    const data = {
      exportedAt: new Date().toISOString(),
      profile,
      listings: listings.map(strip),
      deals: transactions.map(strip),
      onlineOrders: orders.map(strip),
      whatsappOrders: orderRequests.map(strip),
      requests: myRequests.map(strip),
      offersMade: myOffers.map((r) => ({ reference: r.reference, type: r.type, deviceName: r.deviceName, status: r.status, offer: r.offers.find((o) => String(o.vendor) === String(me)) })),
      reviewsWritten: reviewsWritten.map(strip),
      reviewsAboutYou: reviewsAboutMe.map(strip),
      disputes: disputes.map(strip),
      notifications: notifications.map(strip),
      stolenReports: stolenReports.map(strip),
      payoutAccount: payoutAccount ? { ...strip(payoutAccount), accountNumber: `******${payoutAccount.accountNumber.slice(-4)}` } : null,
      stock: inventory.map(strip),
      recommenderChats: conversations.map(strip),
    };
    res.setHeader("Content-Disposition", `attachment; filename="technest-my-data-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/me/email-preferences:
 *   patch:
 *     summary: Turn notification or announcement emails on or off
 *     description: Security emails (email confirmation, password reset) are always sent. In-app notifications are unaffected.
 *     tags: [Me]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notifications: { type: boolean }
 *               announcements: { type: boolean }
 *     responses:
 *       200:
 *         description: data.emailPrefs
 */
router.patch("/email-preferences", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const set = {};
    for (const k of UNSUBSCRIBE_TYPES) if (typeof req.body?.[k] === "boolean") set[`emailPrefs.${k}`] = req.body[k];
    if (!Object.keys(set).length) return sendError(res, 400, "Send notifications and/or announcements as true or false.");
    const user = await User.findByIdAndUpdate(req.user._id, { $set: set }, { returnDocument: "after" }).select("emailPrefs");
    sendSuccess(res, 200, "Email preferences saved", {
      emailPrefs: { notifications: user.emailPrefs?.notifications !== false, announcements: user.emailPrefs?.announcements !== false },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/me/unsubscribe:
 *   get:
 *     summary: One-click unsubscribe link from an email (no login)
 *     description: The link in each email is signed for that user and email type. Shows a small confirmation page.
 *     tags: [Me]
 *     security: []
 *     parameters:
 *       - { in: query, name: u, required: true, schema: { type: string } }
 *       - { in: query, name: t, required: true, schema: { type: string, enum: [notifications, announcements] } }
 *       - { in: query, name: s, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: HTML confirmation page
 *       400:
 *         description: Invalid link
 *   post:
 *     summary: Same, for mail apps' built-in "Unsubscribe" button
 *     tags: [Me]
 *     security: []
 *     responses:
 *       200:
 *         description: Unsubscribed
 */
const unsubscribe = async (req, res, next) => {
  try {
    const { u, t, s } = req.query;
    const valid =
      UNSUBSCRIBE_TYPES.includes(t) &&
      /^[a-f0-9]{24}$/.test(String(u)) &&
      typeof s === "string" &&
      s.length === 32 &&
      crypto.timingSafeEqual(Buffer.from(s), Buffer.from(unsubscribeSignature(String(u), t)));
    const page = (title, body) =>
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
      `<body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 16px;color:#1f2933"><h2>${title}</h2><p>${body}</p></body></html>`;
    if (!valid) return res.status(400).type("html").send(page("Link not valid", "This unsubscribe link isn't valid. You can change email settings in your TechNest account."));
    await User.updateOne({ _id: u }, { $set: { [`emailPrefs.${t}`]: false } });
    const what = t === "announcements" ? "news and announcement" : "notification";
    res.type("html").send(page("You're unsubscribed", `You won't get ${what} emails from TechNest any more. You'll still see them in the app, and we'll still email you about your account's security. You can turn them back on in your account settings.`));
  } catch (err) {
    next(err);
  }
};
router.get("/unsubscribe", unsubscribe);
router.post("/unsubscribe", unsubscribe);

module.exports = router;
