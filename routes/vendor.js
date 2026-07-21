const express = require("express");
const Listing = require("../models/Listing");
const {
  protect,
  restrictTo,
  requireVendorVerified,
} = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/response");
const router = express.Router();

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

module.exports = router;
