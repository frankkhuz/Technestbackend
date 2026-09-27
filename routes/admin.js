const express = require("express");
const User = require("../models/User");
const Listing = require("../models/Listing");
const Notification = require("../models/Notification");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Transaction = require("../models/Transaction");
const AiUsage = require("../models/AiUsage");
const { runListingChecks, findMarketDevice } = require("../utils/listingChecks");
const ai = require("../utils/ai");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const router = express.Router();

// Every route below requires a logged-in admin
router.use(protect, restrictTo("admin"));

/**
 * @swagger
 * /api/admin/vendors/pending:
 *   get:
 *     summary: List vendors who submitted a profile but aren't verified yet
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Pending vendors fetched
 *       403:
 *         description: Not permitted for this account type
 */
router.get("/vendors/pending", async (req, res, next) => {
  try {
    const pending = await User.find({
      userType: "vendor",
      vendorVerified: false,
      "vendorProfile.phone": { $exists: true, $ne: null },
    }).select("name email vendorProfile createdAt");

    sendSuccess(res, 200, "Pending vendors fetched", { vendors: pending });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/vendors:
 *   get:
 *     summary: List all vendor accounts (any status)
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Vendors fetched
 */
router.get("/vendors", async (req, res, next) => {
  try {
    const vendors = await User.find({ userType: "vendor" }).select(
      "name email vendorProfile vendorVerified createdAt"
    );
    sendSuccess(res, 200, "Vendors fetched", { vendors });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/vendors/{id}/approve:
 *   patch:
 *     summary: Approve a pending vendor
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Vendor approved
 *       404:
 *         description: Vendor not found
 */
router.patch(
  "/vendors/:id/approve",
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const vendor = await User.findById(req.params.id);
      if (!vendor || vendor.userType !== "vendor")
        return sendError(res, 404, "Vendor not found");

      vendor.vendorVerified = true;
      await vendor.save();

      sendSuccess(res, 200, "Vendor approved", {
        id: vendor._id,
        name: vendor.name,
        email: vendor.email,
        vendorVerified: vendor.vendorVerified,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/admin/vendors/{id}/reject:
 *   patch:
 *     summary: Reject a pending vendor and clear their profile
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Vendor rejected
 *       404:
 *         description: Vendor not found
 */
router.patch("/vendors/:id/reject", verifyCsrfToken, async (req, res, next) => {
  try {
    const vendor = await User.findById(req.params.id);
    if (!vendor || vendor.userType !== "vendor")
      return sendError(res, 404, "Vendor not found");

    vendor.vendorVerified = false;
    vendor.vendorProfile = undefined; // clear so they must resubmit
    await vendor.save();

    sendSuccess(res, 200, "Vendor rejected", {
      id: vendor._id,
      vendorVerified: vendor.vendorVerified,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/listings:
 *   get:
 *     summary: List all marketplace listings (any moderation status)
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Listings fetched
 */
router.get("/listings", async (req, res, next) => {
  try {
    const listings = await Listing.find({})
      .populate("owner", "name email")
      .sort({ createdAt: -1 });
    sendSuccess(res, 200, "Listings fetched", { listings });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/listings/pending:
 *   get:
 *     summary: List listings awaiting moderation
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     description: Each listing includes `checks[]` — free automatic red-flag checks (price vs market, contact details in text, photos, duplicates, new account).
 *     responses:
 *       200:
 *         description: Pending listings fetched
 */
router.get("/listings/pending", async (req, res, next) => {
  try {
    const pending = await Listing.find({ status: "pending_review" })
      .populate("owner", "name email createdAt")
      .sort({ createdAt: -1 });
    // Free rule-based checks on every pending listing (no AI needed)
    const listings = await Promise.all(
      pending.map(async (l) => ({ ...l.toObject(), checks: await runListingChecks(l) }))
    );
    sendSuccess(res, 200, "Pending listings fetched", { listings });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/listings/{id}/approve:
 *   patch:
 *     summary: Approve a listing, making it visible on the public marketplace
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Listing approved
 *       404:
 *         description: Listing not found
 */
router.patch(
  "/listings/:id/approve",
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const listing = await Listing.findById(req.params.id);
      if (!listing) return sendError(res, 404, "Listing not found");

      listing.status = "active";
      listing.rejectionReason = null;
      await listing.save();

      await Notification.create({
        recipientType: "all_vendors",
        type:
          listing.listingType === "swap"
            ? "new_swap_request"
            : "new_cash_listing",
        title:
          listing.listingType === "swap"
            ? "New swap request"
            : "New cash listing",
        message: `${listing.deviceName} was just listed${
          listing.listingType === "swap" ? " for swap" : " for sale"
        }`,
        listing: listing._id,
      });

      sendSuccess(res, 200, "Listing approved", {
        id: listing._id,
        status: listing.status,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/admin/listings/{id}/reject:
 *   patch:
 *     summary: Reject a listing with an optional reason
 *     tags: [Admin]
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
 *               reason: { type: string }
 *     responses:
 *       200:
 *         description: Listing rejected
 *       404:
 *         description: Listing not found
 */
router.patch(
  "/listings/:id/reject",
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const listing = await Listing.findById(req.params.id);
      if (!listing) return sendError(res, 404, "Listing not found");

      listing.status = "rejected";
      listing.rejectionReason = req.body?.reason || null;
      await listing.save();

      sendSuccess(res, 200, "Listing rejected", {
        id: listing._id,
        status: listing.status,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/admin/orders:
 *   get:
 *     summary: All orders (catalog, listing purchases, swap top-ups)
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, paid, failed, cancelled] }
 *       - in: query
 *         name: fulfillmentStatus
 *         schema: { type: string, enum: [unfulfilled, processing, shipped, delivered] }
 *       - in: query
 *         name: kind
 *         schema: { type: string, enum: [cart, listing, swap] }
 *     responses:
 *       200:
 *         description: Orders fetched
 */
router.get("/orders", async (req, res, next) => {
  try {
    const { status, fulfillmentStatus, kind } = req.query;
    const filter = {};
    if (["pending", "paid", "failed", "cancelled"].includes(status))
      filter.status = status;
    if (
      ["unfulfilled", "processing", "shipped", "delivered"].includes(
        fulfillmentStatus
      )
    )
      filter.fulfillmentStatus = fulfillmentStatus;
    if (["cart", "listing", "swap"].includes(kind)) filter.kind = kind;

    const orders = await Order.find(filter)
      .populate("buyer", "name email")
      .sort({ createdAt: -1 })
      .limit(500);
    sendSuccess(res, 200, "Orders fetched", {
      orders: orders.map((o) => ({
        ...o.toClient(),
        buyer: o.buyer
          ? { id: o.buyer._id, name: o.buyer.name, email: o.buyer.email }
          : null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/orders/{id}/fulfillment:
 *   patch:
 *     summary: Update delivery progress on a paid order
 *     tags: [Admin]
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
 *             required: [fulfillmentStatus]
 *             properties:
 *               fulfillmentStatus: { type: string, enum: [unfulfilled, processing, shipped, delivered] }
 *     responses:
 *       200:
 *         description: Order updated
 *       400:
 *         description: Order isn't paid, or invalid status
 */
router.patch(
  "/orders/:id/fulfillment",
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const { fulfillmentStatus } = req.body;
      if (
        !["unfulfilled", "processing", "shipped", "delivered"].includes(
          fulfillmentStatus
        )
      )
        return sendError(res, 400, "Invalid fulfillmentStatus");

      const order = await Order.findById(req.params.id).catch(() => null);
      if (!order) return sendError(res, 404, "Order not found");
      if (order.status !== "paid")
        return sendError(res, 400, "Only paid orders can be fulfilled");

      order.fulfillmentStatus = fulfillmentStatus;
      await order.save();

      if (fulfillmentStatus === "shipped" || fulfillmentStatus === "delivered") {
        await Notification.create({
          recipientType: "specific",
          recipient: order.buyer,
          type: "transaction_update",
          title:
            fulfillmentStatus === "shipped"
              ? "Your order is on its way"
              : "Your order was delivered",
          message: `${order.toClient().itemName} — ${fulfillmentStatus}.`,
          order: order._id,
        });
      }

      sendSuccess(res, 200, "Order updated", { order: order.toClient() });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/admin/transactions:
 *   get:
 *     summary: All swap / buy / sell deals between users
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [buy, sell, swap] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, accepted, completed, cancelled] }
 *     responses:
 *       200:
 *         description: Transactions fetched
 */
router.get("/transactions", async (req, res, next) => {
  try {
    const { type, status } = req.query;
    const filter = {};
    if (["buy", "sell", "swap"].includes(type)) filter.type = type;
    if (["pending", "accepted", "completed", "cancelled"].includes(status))
      filter.status = status;

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(500);
    sendSuccess(res, 200, "Transactions fetched", {
      transactions: transactions.map((t) => t.toClient()),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/products:
 *   get:
 *     summary: Full catalog including hidden and out-of-stock products
 *     tags: [Admin]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Products fetched
 */
router.get("/products", async (req, res, next) => {
  try {
    const products = await Product.find({}).sort({ type: 1, createdAt: 1 });
    sendSuccess(res, 200, "Products fetched", {
      products: products.map((p) => p.toClient()),
    });
  } catch (err) {
    next(err);
  }
});

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    recommendation: { type: "string", enum: ["approve", "check", "reject"] },
    flags: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: { type: "string", enum: ["high", "medium", "info"] },
          message: { type: "string" },
        },
        required: ["severity", "message"],
      },
    },
    photosMatchDevice: { type: "string", enum: ["yes", "no", "unclear", "no_photos"] },
  },
  required: ["summary", "recommendation", "flags", "photosMatchDevice"],
};

/**
 * @swagger
 * /api/admin/listings/{id}/review:
 *   get:
 *     summary: Review aids for one listing — free checks plus the last AI review
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.checks, data.aiReview (null if never run), data.marketPrice, data.ai (availability)
 *   post:
 *     summary: Run an AI review of the listing (photos + details)
 *     description: >
 *       Optional helper. If AI isn't available it still answers 200 with the
 *       free checks and `aiReason`, so the admin can carry on by hand. The
 *       admin always makes the final approve/reject decision.
 *     tags: [Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.checks, data.aiReview, data.source (ai | rules), data.aiReason
 */
router.get("/listings/:id/review", async (req, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id)
      .populate("owner", "name email createdAt")
      .catch(() => null);
    if (!listing) return sendError(res, 404, "Listing not found");
    const device = findMarketDevice(listing);
    sendSuccess(res, 200, "Review fetched", {
      checks: await runListingChecks(listing),
      aiReview: listing.aiReview || null,
      marketPrice: device ? { deviceId: device.id, name: `${device.name} ${device.storage}`.trim(), baseMax: device.baseMax } : null,
      ai: await ai.getStatus(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/listings/:id/review", verifyCsrfToken, async (req, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id)
      .populate("owner", "name email createdAt")
      .catch(() => null);
    if (!listing) return sendError(res, 404, "Listing not found");

    const checks = await runListingChecks(listing);
    const device = findMarketDevice(listing);
    const images = (listing.images || [])
      .filter((u) => u.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`))
      .slice(0, 4);

    const system = `You help TechNest admins moderate marketplace listings for used gadgets in Nigeria. You don't decide — you give the admin a quick, honest read.

Look at the listing details, the photos, the market price and the automatic checks. Then:
- summary: one or two sentences on what's being sold and anything notable.
- flags: specific concerns, e.g. photos that look like stock/marketing images or show a different model, visible damage not mentioned in the listing, a price far from market, contact or payment details that try to take the deal off-platform, inconsistent details. Don't repeat an automatic check unless you add something to it. Empty if nothing stands out.
- photosMatchDevice: whether the photos show the device described.
- recommendation: "approve" if it looks fine, "check" if the admin should look closer or ask the seller, "reject" only for clear scams or rule-breaking.`;

    const details = {
      deviceName: listing.deviceName,
      storage: listing.storage,
      category: listing.deviceCategory,
      listingType: listing.listingType,
      askingPrice: listing.estimatedMax,
      priceRange: [listing.estimatedMin, listing.estimatedMax],
      batteryHealth: listing.batteryHealth,
      simType: listing.simType,
      faceIdStatus: listing.faceIdStatus,
      repairs: listing.repairs,
      description: listing.description,
      wantedDevice: listing.wantedDevice,
      imeiVerified: listing.imeiVerified,
      marketPrice: device ? device.baseMax : null,
      automaticChecks: checks,
    };
    const content = [
      ...images.map((url) => ({ type: "image", source: { type: "url", url } })),
      { type: "text", text: `Listing (JSON): ${JSON.stringify(details)}` },
    ];

    const result = await ai.run({
      feature: "listing_review",
      system,
      messages: [{ role: "user", content }],
      schema: REVIEW_SCHEMA,
      effort: "medium",
    });
    if (!result.ok)
      return sendSuccess(res, 200, "AI review unavailable — use the automatic checks", {
        source: "rules",
        aiReason: result.reason,
        checks,
        aiReview: listing.aiReview || null,
      });

    listing.aiReview = { ...result.data, at: new Date() };
    await listing.save();
    sendSuccess(res, 200, "AI review ready", { source: "ai", checks, aiReview: listing.aiReview });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/ai:
 *   get:
 *     summary: AI status, the on/off switch, and usage/cost for the last 30 days
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: data.status, data.dailyLimit, data.usage (per day and feature), data.totals (with estimatedCostUsd)
 *   patch:
 *     summary: Turn AI on or off for the whole app (no redeploy)
 *     description: Everything keeps working with AI off — features use their manual/rules path. Turning AI on also clears an automatic pause.
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [enabled]
 *             properties:
 *               enabled: { type: boolean }
 *     responses:
 *       200:
 *         description: New status
 */
router.get("/ai", async (req, res, next) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = await AiUsage.find({ day: { $gte: since } }).sort({ day: -1, feature: 1 });
    const totals = rows.reduce(
      (t, r) => {
        for (const k of ["calls", "failures", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"])
          t[k] += r[k] || 0;
        return t;
      },
      { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    );
    sendSuccess(res, 200, "AI status fetched", {
      status: await ai.getStatus(),
      model: ai.MODEL,
      dailyLimit: ai.dailyLimit(),
      usage: rows.map((r) => ({
        day: r.day,
        feature: r.feature,
        calls: r.calls,
        failures: r.failures,
        estimatedCostUsd: Number(ai.estimateCostUsd(r).toFixed(4)),
      })),
      totals: { ...totals, estimatedCostUsd: Number(ai.estimateCostUsd(totals).toFixed(2)) },
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/ai", verifyCsrfToken, async (req, res, next) => {
  try {
    if (typeof req.body.enabled !== "boolean")
      return sendError(res, 400, "enabled must be true or false");
    await ai.setAdminEnabled(req.body.enabled);
    sendSuccess(res, 200, req.body.enabled ? "AI turned on" : "AI turned off", {
      status: await ai.getStatus(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
