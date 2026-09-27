const express = require("express");
const Listing = require("../models/Listing");
const InventoryItem = require("../models/Inventoryitem");
const Notification = require("../models/Notification");
const {
  protect,
  restrictTo,
  requireVendorVerified,
} = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const router = express.Router();

/**
 * @swagger
 * /api/vendor/upgrade:
 *   patch:
 *     summary: Turn the current user account into a vendor account (also at /api/vendors/upgrade)
 *     tags: [Vendor]
 *     responses:
 *       200:
 *         description: Account upgraded to vendor
 */
router.patch("/upgrade", protect, async (req, res, next) => {
  try {
    if (req.user.userType === "admin")
      return sendError(res, 400, "Not applicable for this account");

    if (req.user.userType !== "vendor") {
      req.user.userType = "vendor";
      await req.user.save();
    }

    sendSuccess(res, 200, "Account upgraded to vendor", {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      userType: req.user.userType,
      isVerified: req.user.isVerified,
      createdAt: req.user.createdAt,
      vendorVerified: req.user.vendorVerified,
      vendorProfile: req.user.vendorProfile,
    });
  } catch (err) {
    next(err);
  }
});

// CHANGED: this endpoint used to set vendorVerified = true immediately,
// which let any vendor self-approve. It now only submits the vendor
// profile for review. An admin must approve via /api/admin/vendors/:id/approve
// before vendorVerified becomes true.
/**
 * @swagger
 * /api/vendor/verify:
 *   patch:
 *     summary: Submit the vendor profile for admin review (also at /api/vendors/verify)
 *     description: Does not verify the vendor — an admin approves via /api/admin/vendors/{id}/approve. Call POST /api/auth/refresh afterwards so the token picks up vendorVerified.
 *     tags: [Vendor]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone, businessRegNumber, shopAddress]
 *             properties:
 *               phone: { type: string }
 *               businessRegNumber: { type: string }
 *               shopAddress: { type: string }
 *     responses:
 *       200:
 *         description: Vendor profile submitted for review
 */
router.patch("/verify", protect, async (req, res, next) => {
  try {
    if (req.user.userType !== "vendor")
      return sendError(res, 400, "Upgrade to a vendor account first");

    const { phone, businessRegNumber, shopAddress } = req.body;

    if (!phone || !businessRegNumber || !shopAddress)
      return sendError(
        res,
        400,
        "Phone, business registration number, and shop address are required"
      );

    req.user.vendorProfile = { phone, businessRegNumber, shopAddress };
    // vendorVerified intentionally left untouched here — admin approves separately
    await req.user.save();

    sendSuccess(res, 200, "Vendor profile submitted for review", {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      userType: req.user.userType,
      isVerified: req.user.isVerified,
      createdAt: req.user.createdAt,
      vendorVerified: req.user.vendorVerified,
      vendorProfile: req.user.vendorProfile,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/vendor/dashboard:
 *   get:
 *     summary: Verified vendor's own listings and stats
 *     tags: [Vendor]
 *     responses:
 *       200:
 *         description: Dashboard fetched
 */
router.get(
  "/dashboard",
  protect,
  restrictTo("vendor"),
  requireVendorVerified,
  async (req, res, next) => {
    try {
      const listings = await Listing.find({ owner: req.user._id }).sort({
        createdAt: -1,
      });

      const active = listings.filter((l) => l.status === "active");
      const sold = listings.filter((l) => l.status === "sold");
      const swapped = listings.filter((l) => l.status === "swapped");
      const removed = listings.filter((l) => l.status === "removed");

      const totalValueActive = active.reduce(
        (sum, l) => sum + (l.estimatedMax || 0),
        0
      );

      const recentListings = listings.slice(0, 5);

      const accountAgeDays = Math.floor(
        (Date.now() - new Date(req.user.createdAt).getTime()) /
          (1000 * 60 * 60 * 24)
      );

      sendSuccess(res, 200, "Dashboard fetched", {
        vendor: {
          id: req.user._id,
          name: req.user.name,
          email: req.user.email,
          vendorProfile: req.user.vendorProfile,
          memberSince: req.user.createdAt,
          accountAgeDays,
        },
        stats: {
          totalListings: listings.length,
          active: active.length,
          sold: sold.length,
          swapped: swapped.length,
          removed: removed.length,
          totalValueActive,
        },
        recentListings,
        listings,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/vendor/inventory:
 *   get:
 *     summary: Get the logged-in vendor's inventory
 *     tags: [Vendor]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Inventory fetched
 */
router.get(
  "/inventory",
  protect,
  restrictTo("vendor"),
  async (req, res, next) => {
    try {
      const inventory = await InventoryItem.find({
        vendor: req.user._id,
      }).sort({ createdAt: -1 });
      sendSuccess(res, 200, "Inventory fetched", { inventory });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/vendor/inventory:
 *   post:
 *     summary: Add a device to the vendor's inventory
 *     tags: [Vendor]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deviceName, buyPrice, sellPrice]
 *             properties:
 *               deviceName: { type: string }
 *               buyPrice: { type: number }
 *               sellPrice: { type: number }
 *               condition: { type: string }
 *     responses:
 *       201:
 *         description: Inventory item created
 */
router.post(
  "/inventory",
  protect,
  restrictTo("vendor"),
  requireVendorVerified,
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const { deviceName, buyPrice, sellPrice, condition } = req.body;

      if (!deviceName || buyPrice === undefined || sellPrice === undefined)
        return sendError(
          res,
          400,
          "deviceName, buyPrice, and sellPrice are required"
        );

      const item = await InventoryItem.create({
        vendor: req.user._id,
        deviceName,
        buyPrice,
        sellPrice,
        condition: condition || "UK Used",
      });

      sendSuccess(res, 201, "Inventory item created", { item });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/vendor/inventory:
 *   patch:
 *     summary: Update an inventory item (e.g. mark as sold)
 *     tags: [Vendor]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [id]
 *             properties:
 *               id: { type: string }
 *               status: { type: string, enum: [in_stock, sold] }
 *     responses:
 *       200:
 *         description: Inventory item updated
 */
router.patch(
  "/inventory",
  protect,
  restrictTo("vendor"),
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const { id, status, deviceName, buyPrice, sellPrice, condition } =
        req.body;
      if (!id) return sendError(res, 400, "id is required");

      const item = await InventoryItem.findOne({
        _id: id,
        vendor: req.user._id,
      });
      if (!item) return sendError(res, 404, "Inventory item not found");

      if (deviceName !== undefined) item.deviceName = deviceName;
      if (buyPrice !== undefined) item.buyPrice = buyPrice;
      if (sellPrice !== undefined) item.sellPrice = sellPrice;
      if (condition !== undefined) item.condition = condition;
      if (status !== undefined) {
        item.status = status;
        item.soldAt = status === "sold" ? new Date() : null;
      }

      await item.save();
      sendSuccess(res, 200, "Inventory item updated", { item });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/vendor/bid:
 *   post:
 *     summary: Place a bid on a listing
 *     tags: [Vendor]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listingId, amount]
 *             properties:
 *               listingId: { type: string }
 *               amount: { type: number }
 *               message: { type: string }
 *     responses:
 *       201:
 *         description: Bid placed
 *       403:
 *         description: Vendor not verified
 *       404:
 *         description: Listing not found
 */
router.post(
  "/bid",
  protect,
  restrictTo("vendor"),
  requireVendorVerified,
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const { listingId, amount, message } = req.body;
      if (!listingId || amount === undefined)
        return sendError(res, 400, "listingId and amount are required");

      const listing = await Listing.findById(listingId);
      if (!listing) return sendError(res, 404, "Listing not found");
      if (listing.status !== "active")
        return sendError(res, 400, "This listing is not open for offers");

      listing.bids.push({
        vendor: req.user._id,
        vendorName: req.user.name,
        amount: Number(amount),
        message: message || "",
      });
      await listing.save();

      // Notify the seller — only meaningful if the listing has a
      // registered owner (all current listings do, via protect on create)
      if (listing.owner) {
        await Notification.create({
          recipientType: "specific",
          recipient: listing.owner,
          type: "bid_placed",
          title: "New offer on your listing",
          message: `${req.user.name} offered ₦${Number(
            amount
          ).toLocaleString()} for your ${listing.deviceName}`,
          listing: listing._id,
        });
      }

      sendSuccess(res, 201, "Bid placed", { listing });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
