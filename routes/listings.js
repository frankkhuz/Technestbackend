const express = require("express");
const mongoose = require("mongoose");
const Listing = require("../models/Listing");
const Transaction = require("../models/Transaction");
const Notification = require("../models/Notification");
const { protect } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { templateDescription } = require("../utils/listingChecks");
const { getAllDevices } = require("../utils/valuation");
const ai = require("../utils/ai");
const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     ListingInput:
 *       type: object
 *       required: [userName, userPhone, deviceName, deviceCategory, subType, estimatedMin, estimatedMax]
 *       properties:
 *         userName: { type: string }
 *         userPhone: { type: string }
 *         deviceName: { type: string, example: iPhone 15 Pro }
 *         deviceCategory: { type: string, enum: [phone, laptop, tablet, wearable, accessory, other] }
 *         subType: { type: string, example: iphone }
 *         storage: { type: string, example: 256GB }
 *         batteryHealth: { type: string, example: "88" }
 *         simType: { type: string, enum: [physical, esim-unlocked, locked] }
 *         faceIdStatus: { type: string, enum: [working, broken] }
 *         repairs: { type: array, items: { type: string } }
 *         description: { type: string, maxLength: 1000 }
 *         images: { type: array, maxItems: 10, items: { type: string, description: Cloudinary secure_url } }
 *         mediaCount: { type: integer }
 *         imeiVerified: { type: boolean }
 *         estimatedMin: { type: number }
 *         estimatedMax: { type: number, description: "Asking price — used as the seller price at checkout" }
 *         listingType: { type: string, enum: [sell, swap], default: sell }
 *         wantedDevice: { type: string, description: swap listings only }
 * /api/listings:
 *   get:
 *     summary: Public marketplace listings (active by default)
 *     tags: [Listings]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: listingType
 *         schema: { type: string, enum: [sell, swap] }
 *       - in: query
 *         name: deviceCategory
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, default: active }
 *     responses:
 *       200:
 *         description: "data.listings — each with populated owner { _id, name, email, vendorProfile } and bids[]"
 */
router.get("/", async (req, res, next) => {
  try {
    const { deviceCategory, listingType, status } = req.query;

    const filter = { status: status || "active" };
    if (deviceCategory) filter.deviceCategory = deviceCategory;
    if (listingType) filter.listingType = listingType;

    const listings = await Listing.find(filter)
      .populate("owner", "name email vendorProfile")
      .sort({ createdAt: -1 });

    res.json({ success: true, data: { listings } });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/listings/mine:
 *   get:
 *     summary: The logged-in user's own listings, any status, with vendor bids
 *     tags: [Listings]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Listings fetched
 */
router.get("/mine", protect, async (req, res, next) => {
  try {
    const listings = await Listing.find({ owner: req.user._id }).sort({
      createdAt: -1,
    });
    res.json({ success: true, data: { listings } });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/listings/{id}:
 *   get:
 *     summary: One listing
 *     tags: [Listings]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.listing
 *       404:
 *         description: Listing not found
 *   patch:
 *     summary: Edit your listing, or change its status
 *     description: >
 *       Changing any content field sends the listing back to pending_review.
 *       `status` can be set to active / sold / swapped / removed by the owner
 *       (not while pending review).
 *     tags: [Listings]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             allOf:
 *               - $ref: '#/components/schemas/ListingInput'
 *               - type: object
 *                 properties:
 *                   status: { type: string, enum: [active, sold, swapped, removed] }
 *     responses:
 *       200:
 *         description: data.listing
 *       403:
 *         description: Not your listing
 *   delete:
 *     summary: Delete your listing
 *     tags: [Listings]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Listing deleted
 *       403:
 *         description: Not your listing
 */
router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id))
      return res
        .status(404)
        .json({ success: false, error: "Listing not found" });
    const listing = await Listing.findById(req.params.id).populate(
      "owner",
      "name email vendorProfile"
    );
    if (!listing)
      return res
        .status(404)
        .json({ success: false, error: "Listing not found" });
    res.json({ success: true, data: { listing } });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/listings:
 *   post:
 *     summary: Create a sell or swap listing (starts as pending_review)
 *     description: Upload images first via POST /api/uploads/signature + Cloudinary, then send the URLs.
 *     tags: [Listings]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/ListingInput' }
 *     responses:
 *       201:
 *         description: data.listing
 *       400:
 *         description: Missing required fields
 */
router.post("/", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const {
      userName,
      userPhone,
      deviceName,
      deviceCategory,
      subType,
      storage,
      batteryHealth,
      simType,
      faceIdStatus,
      repairs,
      mediaCount,
      images,
      imeiVerified,
      estimatedMin,
      estimatedMax,
      listingType,
      wantedDevice,
      description,
    } = req.body;

    if (
      !userName ||
      !userPhone ||
      !deviceName ||
      !deviceCategory ||
      !subType ||
      estimatedMin === undefined ||
      estimatedMax === undefined
    )
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields" });

    // images should just be Cloudinary secure_urls — cap defensively even
    // though the frontend already limits to 10, since this is untrusted input
    const safeImages = Array.isArray(images)
      ? images.filter((u) => typeof u === "string").slice(0, 10)
      : [];

    const listing = await Listing.create({
      userName,
      userPhone,
      deviceName,
      deviceCategory,
      subType,
      storage,
      batteryHealth,
      simType,
      faceIdStatus,
      repairs: repairs || [],
      description: typeof description === "string" ? description.slice(0, 1000) : null,
      mediaCount: mediaCount || 0,
      images: safeImages,
      imeiVerified: !!imeiVerified,
      estimatedMin,
      estimatedMax,
      listingType: listingType || "sell",
      wantedDevice: listingType === "swap" ? wantedDevice : null,
      owner: req.user._id,
      // status defaults to "pending_review" from the schema — new
      // listings are invisible on the public marketplace until an admin
      // approves them
    });

    res.status(201).json({ success: true, data: { listing } });
  } catch (err) {
    next(err);
  }
});

// Only images we uploaded ourselves (signed Cloudinary uploads) go to AI
const isOurImage = (url) =>
  typeof url === "string" &&
  url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`);

const ASSIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    deviceCategory: { type: "string", enum: ["phone", "laptop", "tablet", "wearable", "accessory", "other"] },
    subType: { type: "string", description: "iphone, android, macbook, windows, linux, gaming, or \"\"" },
    deviceId: { type: "string", description: "Exact id from the device list, or \"\" if unsure" },
    deviceName: { type: "string" },
    storage: { type: "string", description: "Only if visible or given, else \"\"" },
    description: { type: "string" },
    visibleIssues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          part: { type: "string", enum: ["screen", "back_glass", "camera", "body", "other"] },
          issue: { type: "string" },
        },
        required: ["part", "issue"],
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
  },
  required: ["deviceCategory", "subType", "deviceId", "deviceName", "storage", "description", "visibleIssues", "confidence"],
};

/**
 * @swagger
 * /api/listings/assist:
 *   post:
 *     summary: Suggest listing details — AI reads the photos when available, otherwise a plain template
 *     description: >
 *       Nothing is saved; show the suggestion in the form for the seller to
 *       edit. Always returns a `suggestion.description`. With AI (`source: ai`)
 *       it also guesses the device from the photos and lists visible damage
 *       (`visibleIssues`) — show those as warnings, don't silently tick
 *       condition boxes. With no AI (`source: rules`, see `aiReason`) the
 *       description is built from the form fields.
 *     tags: [Listings]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               images: { type: array, maxItems: 4, items: { type: string, description: Cloudinary secure_url from our own upload } }
 *               fields:
 *                 type: object
 *                 description: Whatever the seller has filled in so far
 *                 properties:
 *                   deviceName: { type: string }
 *                   storage: { type: string }
 *                   batteryHealth: { type: string }
 *                   simType: { type: string }
 *                   faceIdStatus: { type: string }
 *                   repairs: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: data.suggestion, data.source (ai | rules), data.aiReason
 */
router.post("/assist", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const fields = req.body.fields && typeof req.body.fields === "object" ? req.body.fields : {};
    const images = Array.isArray(req.body.images) ? req.body.images.filter(isOurImage).slice(0, 4) : [];
    const rulesSuggestion = { description: templateDescription(fields), visibleIssues: [] };

    if (!images.length && !fields.deviceName)
      return sendSuccess(res, 200, "Suggestion ready", { source: "rules", suggestion: rulesSuggestion });

    const tables = getAllDevices();
    const deviceList = [...tables.iphone, ...tables.android]
      .filter((d) => !d.id.startsWith("other-"))
      .map((d) => ({ id: d.id, name: d.name, storage: d.storage }));

    const system = `You help sellers on TechNest, a Nigerian marketplace for UK-used gadgets, create honest listings.

From the photos (if any) and the details the seller has already entered:
- Identify the device. Use an exact id from the device list below only when you're confident of both model and storage; otherwise deviceId "". Don't guess storage from photos unless it's shown (e.g. a settings screen or box label).
- List visible damage or wear you can actually see (cracks, deep scratches, dents, lens damage, screen burn). Don't invent issues; an empty list is fine.
- Write a short, honest description (2–4 sentences, plain English) a buyer would trust: model, storage if known, battery health if given, SIM/lock status if given, repairs, and any visible issues. No prices, no phone numbers, no links, no hype.
- confidence: how sure you are of the device identification.

Phone devices TechNest can value (JSON):
${JSON.stringify(deviceList)}`;

    const content = [
      ...images.map((url) => ({ type: "image", source: { type: "url", url } })),
      { type: "text", text: `Details entered so far (JSON): ${JSON.stringify(fields).slice(0, 2000)}` },
    ];

    const result = await ai.run({
      feature: "listing_assist",
      system,
      messages: [{ role: "user", content }],
      schema: ASSIST_SCHEMA,
      effort: "medium",
    });
    if (!result.ok)
      return sendSuccess(res, 200, "Suggestion ready", {
        source: "rules",
        aiReason: result.reason,
        suggestion: rulesSuggestion,
      });

    const known = new Set(deviceList.map((d) => d.id));
    const s = result.data;
    sendSuccess(res, 200, "Suggestion ready", {
      source: "ai",
      suggestion: {
        deviceCategory: s.deviceCategory,
        subType: s.subType || undefined,
        deviceId: known.has(s.deviceId) ? s.deviceId : undefined,
        deviceName: s.deviceName || undefined,
        storage: s.storage || undefined,
        description: s.description.slice(0, 1000),
        visibleIssues: s.visibleIssues,
        confidence: s.confidence,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing)
      return res
        .status(404)
        .json({ success: false, error: "Listing not found" });

    if (!listing.owner || listing.owner.toString() !== req.user._id.toString())
      return res
        .status(403)
        .json({ success: false, error: "Not your listing" });

    const contentFields = [
      "userName",
      "userPhone",
      "deviceName",
      "deviceCategory",
      "subType",
      "storage",
      "batteryHealth",
      "simType",
      "faceIdStatus",
      "repairs",
      "description",
      "mediaCount",
      "images",
      "imeiVerified",
      "estimatedMin",
      "estimatedMax",
      "listingType",
      "wantedDevice",
    ];

    for (const field of contentFields) {
      if (req.body[field] !== undefined) listing[field] = req.body[field];
    }

    // Editing listing content sends it back through moderation rather than
    // letting an owner slip changes past review on an already-approved
    // listing.
    if (contentFields.some((f) => req.body[f] !== undefined)) {
      listing.status = "pending_review";
      listing.rejectionReason = null;
    }

    // Status transitions like marking sold/swapped/removed stay entirely
    // owner-controlled and don't need re-review — only admin-gated
    // transitions (pending_review/rejected → active) require the separate
    // admin approve/reject routes.
    const ownerSettableStatuses = ["active", "sold", "swapped", "removed"];
    if (
      req.body.status !== undefined &&
      ownerSettableStatuses.includes(req.body.status) &&
      listing.status !== "pending_review"
    ) {
      listing.status = req.body.status;
    }

    await listing.save();
    res.json({ success: true, data: { listing } });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/listings/{id}/bids/{bidId}/accept:
 *   post:
 *     summary: Seller accepts a vendor's offer on their listing
 *     description: >
 *       Creates an accepted "sell" transaction at the bid amount (listing
 *       owner = seller, vendor = buyer) and notifies the vendor. The listing
 *       is marked sold when either side completes the transaction via
 *       PATCH /api/transactions/{id}.
 *     tags: [Listings]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: bidId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201:
 *         description: Offer accepted
 *       403:
 *         description: Not your listing
 *       404:
 *         description: Listing or bid not found
 *       409:
 *         description: Listing not active, or an offer was already accepted
 */
router.post(
  "/:id/bids/:bidId/accept",
  protect,
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id))
        return res
          .status(404)
          .json({ success: false, error: "Listing not found" });
      const listing = await Listing.findById(req.params.id);
      if (!listing)
        return res
          .status(404)
          .json({ success: false, error: "Listing not found" });
      if (!listing.owner || listing.owner.toString() !== req.user._id.toString())
        return res
          .status(403)
          .json({ success: false, error: "Not your listing" });
      if (listing.status !== "active")
        return res
          .status(409)
          .json({ success: false, error: "This listing is not open for offers" });

      const bid = listing.bids.id(req.params.bidId);
      if (!bid)
        return res.status(404).json({ success: false, error: "Offer not found" });

      const alreadyAccepted = await Transaction.findOne({
        listing: listing._id,
        type: "sell",
        status: { $in: ["accepted", "completed"] },
      });
      if (alreadyAccepted)
        return res.status(409).json({
          success: false,
          error: "You've already accepted an offer on this listing",
        });

      const transaction = await Transaction.create({
        type: "sell",
        listing: listing._id,
        listingDeviceName: listing.deviceName,
        listingStorage: listing.storage || null,
        seller: req.user._id,
        sellerName: req.user.name,
        buyer: bid.vendor,
        buyerName: bid.vendorName,
        agreedPrice: bid.amount,
        bid: bid._id,
        message: bid.message || null,
        status: "accepted",
      });

      await Notification.create({
        recipientType: "specific",
        recipient: bid.vendor,
        type: "offer_accepted",
        title: "Your offer was accepted",
        message: `${req.user.name} accepted your ₦${bid.amount.toLocaleString()} offer for their ${listing.deviceName}. Reach out to arrange pickup.`,
        listing: listing._id,
        transaction: transaction._id,
      });

      res.status(201).json({
        success: true,
        data: {
          transaction: transaction.toClient(),
          seller: { name: listing.userName, phone: listing.userPhone },
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

router.delete("/:id", protect, verifyCsrfToken, async (req, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing)
      return res
        .status(404)
        .json({ success: false, error: "Listing not found" });

    if (!listing.owner || listing.owner.toString() !== req.user._id.toString())
      return res
        .status(403)
        .json({ success: false, error: "Not your listing" });

    await listing.deleteOne();
    res.json({ success: true, data: { message: "Listing deleted" } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
