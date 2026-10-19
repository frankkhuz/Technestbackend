const express = require("express");
const Listing = require("../models/Listing");
const User = require("../models/User");
const InventoryItem = require("../models/Inventoryitem");
const {
  protect,
  restrictTo,
  requireVerified,
  requireVendorVerified,
} = require("../middleware/auth");
const { notify, notifyAdmins } = require("../utils/notify");
const { normalizeNigerianPhone } = require("../utils/pricing");
const { listingUnavailableReason } = require("../utils/availability");
const { normalizeStates } = require("../utils/nigeria");
const { isOwnPrivateUpload } = require("../utils/identity");
const { parseCsvWithHeader } = require("../utils/csv");
const VENDOR_TYPES = ["phone_dealer", "gadgets", "accessories", "repairs"];
const REPAIR_IDS = new Set(require("../data/repairs.json").map((r) => r.id));
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
 *     description: >
 *       Does not verify the vendor — an admin approves via
 *       /api/admin/vendors/{id}/approve. `vendorTypes`, `states`, `brands` and
 *       `repairServices` decide which customer requests reach this vendor
 *       (vendorTypes defaults to phone_dealer). Upload the CAC certificate
 *       with POST /api/uploads/signature { purpose: "private" } and send its
 *       public_id. Call POST /api/auth/refresh after approval so the token
 *       picks up vendorVerified.
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
 *               businessRegNumber: { type: string, example: RC1234567 }
 *               shopAddress: { type: string }
 *               businessName: { type: string }
 *               vendorTypes: { type: array, items: { type: string, enum: [phone_dealer, gadgets, accessories, repairs] } }
 *               brands: { type: array, items: { type: string }, example: [Apple, Samsung] }
 *               states: { type: array, items: { type: string }, description: "Nigerian states served; empty = nationwide", example: [Lagos, Ogun] }
 *               city: { type: string }
 *               repairServices: { type: array, items: { type: string }, description: "ids from GET /api/repair-triage/services (repairers)" }
 *               cacCertificateId: { type: string, description: private upload public_id }
 *     responses:
 *       200:
 *         description: Vendor profile submitted for review
 *       400:
 *         description: Missing or invalid fields
 */
router.patch("/verify", protect, requireVerified, async (req, res, next) => {
  try {
    if (req.user.userType !== "vendor")
      return sendError(res, 400, "Upgrade to a vendor account first");

    const shopAddress = String(req.body.shopAddress || "").trim().slice(0, 200);
    const businessRegNumber = String(req.body.businessRegNumber || "").toUpperCase().replace(/[\s-]/g, "");

    if (!req.body.phone || !businessRegNumber || !shopAddress)
      return sendError(
        res,
        400,
        "Phone, business registration number, and shop address are required"
      );
    const phone = normalizeNigerianPhone(req.body.phone);
    if (!phone)
      return sendError(res, 400, "Enter a valid Nigerian phone number, e.g. 0803 123 4567.");
    if (!/^(RC|BN|IT|LLP|LP)?\d{1,8}$/.test(businessRegNumber))
      return sendError(res, 400, "Enter your CAC number as it appears on your certificate, e.g. RC1234567 or BN1234567.");

    const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean);
    const vendorTypes = list(req.body.vendorTypes).filter((t) => VENDOR_TYPES.includes(t));
    const repairServices = list(req.body.repairServices).filter((id) => REPAIR_IDS.has(id));
    const { cacCertificateId } = req.body;
    if (cacCertificateId !== undefined && cacCertificateId !== null && !isOwnPrivateUpload(cacCertificateId, req.user._id))
      return sendError(res, 400, "Upload your CAC certificate again.");

    req.user.vendorProfile = {
      phone,
      businessRegNumber,
      shopAddress,
      businessName: String(req.body.businessName || "").trim().slice(0, 100) || undefined,
      vendorTypes: vendorTypes.length ? [...new Set(vendorTypes)] : ["phone_dealer"],
      brands: list(req.body.brands).slice(0, 30).map((b) => b.slice(0, 40)),
      states: normalizeStates(list(req.body.states)),
      city: String(req.body.city || "").trim().slice(0, 60) || undefined,
      repairServices,
    };
    if (cacCertificateId) req.user.vendorDocuments = { cacCertificateId };
    // vendorVerified intentionally left untouched here — admin approves separately
    await req.user.save();

    await notifyAdmins({
      type: "admin_alert",
      title: "Vendor application to review",
      message: `${req.user.vendorProfile.businessName || req.user.name} applied as a vendor (${req.user.vendorProfile.vendorTypes.join(", ")}).`,
    });

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
  requireVerified,
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
      if (listingUnavailableReason(listing))
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
        await notify({
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

const CONDITIONS = ["New", "UK Used", "Refurbished", "Nigerian Used"];

/**
 * @swagger
 * /api/vendor/inventory/bulk:
 *   post:
 *     summary: Approved vendor — add many stock items from a CSV
 *     description: >
 *       Header row required. Columns: deviceName, buyPrice, sellPrice,
 *       condition (New, UK Used, Refurbished, Nigerian Used — default UK
 *       Used), storage, category, quantity (adds that many identical units,
 *       max 50). Up to 500 rows. Stock you hold helps match you to customer
 *       requests. Send `dryRun: true` to check the file first.
 *     tags: [Vendor]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [csv]
 *             properties:
 *               csv: { type: string }
 *               dryRun: { type: boolean }
 *     responses:
 *       200:
 *         description: "data: { added, failed, dryRun, errors: [{ line, error }] }"
 */
router.post(
  "/inventory/bulk",
  protect,
  restrictTo("vendor"),
  requireVendorVerified,
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const { rows } = parseCsvWithHeader(req.body.csv);
      if (!rows.length) return sendError(res, 400, "The CSV needs a header row and at least one item.");
      if (rows.length > 500) return sendError(res, 400, "Upload at most 500 rows at a time.");

      const docs = [];
      const errors = [];
      for (const { line, values: v } of rows) {
        const money = (x) => Number(String(x || "").replace(/[₦,\s]/g, ""));
        const deviceName = String(v.devicename || v.device || v.name || "").trim().slice(0, 150);
        const buyPrice = money(v.buyprice);
        const sellPrice = money(v.sellprice);
        const condition = v.condition ? CONDITIONS.find((c) => c.toLowerCase() === v.condition.trim().toLowerCase()) : "UK Used";
        const quantity = v.quantity ? parseInt(v.quantity) : 1;
        if (!deviceName) errors.push({ line, error: "deviceName is required" });
        else if (!(buyPrice >= 0) || !(sellPrice >= 0) || !v.buyprice || !v.sellprice) errors.push({ line, error: "buyPrice and sellPrice must be amounts in naira" });
        else if (!condition) errors.push({ line, error: `condition must be one of: ${CONDITIONS.join(", ")}` });
        else if (!(quantity >= 1 && quantity <= 50)) errors.push({ line, error: "quantity must be 1–50" });
        else
          for (let i = 0; i < quantity; i++)
            docs.push({
              vendor: req.user._id,
              deviceName,
              buyPrice,
              sellPrice,
              condition,
              storage: String(v.storage || "").trim().slice(0, 30) || null,
              category: String(v.category || "").trim().toLowerCase().slice(0, 40) || null,
            });
      }

      const dryRun = req.body.dryRun === true;
      if (!dryRun && docs.length) await InventoryItem.insertMany(docs);
      sendSuccess(res, 200, dryRun ? "Preview — nothing saved" : "Stock uploaded", {
        added: docs.length,
        failed: errors.length,
        dryRun,
        errors,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/vendors/directory:
 *   get:
 *     summary: Approved vendors — what they do and where (no contact details; TechNest arranges deals)
 *     tags: [Vendor]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [phone_dealer, gadgets, accessories, repairs] }
 *       - in: query
 *         name: state
 *         schema: { type: string, example: Lagos }
 *       - in: query
 *         name: repairService
 *         schema: { type: string, description: id from GET /api/repair-triage/services }
 *     responses:
 *       200:
 *         description: "data.vendors: [{ id, name, vendorTypes, brands, states, city, repairServices, identityVerified, memberSince }]"
 */
router.get("/directory", async (req, res, next) => {
  try {
    const and = [{ userType: "vendor" }, { vendorVerified: true }];
    if (VENDOR_TYPES.includes(req.query.type)) and.push({ "vendorProfile.vendorTypes": req.query.type });
    const state = normalizeStates([req.query.state])[0];
    // Vendors with no states listed serve everywhere
    if (state) and.push({ $or: [{ "vendorProfile.states": state }, { "vendorProfile.states": { $in: [null, []] } }] });
    if (REPAIR_IDS.has(req.query.repairService)) and.push({ "vendorProfile.repairServices": req.query.repairService });

    const vendors = await User.find({ $and: and })
      .select("name vendorProfile identityVerified createdAt")
      .sort({ identityVerified: -1, createdAt: 1 })
      .limit(200);
    sendSuccess(res, 200, "Vendors fetched", {
      vendors: vendors.map((v) => ({
        id: v._id,
        name: v.vendorProfile?.businessName || v.name,
        vendorTypes: v.vendorProfile?.vendorTypes?.length ? v.vendorProfile.vendorTypes : ["phone_dealer"],
        brands: v.vendorProfile?.brands || [],
        states: v.vendorProfile?.states || [],
        city: v.vendorProfile?.city || null,
        repairServices: v.vendorProfile?.repairServices || [],
        identityVerified: v.identityVerified,
        memberSince: v.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
