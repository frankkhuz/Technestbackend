const express = require("express");
const Listing = require("../models/Listing");
const router = express.Router();

────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
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
      imeiVerified,
      estimatedMin,
      estimatedMax,
      listingType,
      wantedDevice,
    } = req.body;

    if (!userName || !userPhone || !deviceName || !deviceCategory || !subType) {
      return res.status(400).json({
        error:
          "userName, userPhone, deviceName, deviceCategory and subType are required",
      });
    }
    if (!estimatedMin || !estimatedMax) {
      return res
        .status(400)
        .json({ error: "estimatedMin and estimatedMax are required" });
    }
    if (listingType === "swap" && !wantedDevice) {
      return res
        .status(400)
        .json({ error: "wantedDevice is required for swap listings" });
    }

    const listing = await Listing.create({
      userName,
      userPhone,
      deviceName,
      deviceCategory,
      subType,
      storage: storage || null,
      batteryHealth: batteryHealth || null,
      simType: simType || null,
      faceIdStatus: faceIdStatus || null,
      repairs: Array.isArray(repairs) ? repairs : [],
      mediaCount: mediaCount || 0,
      imeiVerified: imeiVerified === true,
      estimatedMin: Number(estimatedMin),
      estimatedMax: Number(estimatedMax),
      listingType: listingType || "sell",
      wantedDevice: wantedDevice || null,
    });

    res.status(201).json(listing);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const { category, subType, type, q, minPrice, maxPrice } = req.query;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 12));

    const filter = { status: "active" };

    if (category) filter.deviceCategory = category;
    if (subType) filter.subType = subType;
    if (type) filter.listingType = type;
    if (q) filter.$text = { $search: q };

    if (minPrice || maxPrice) {
      filter.estimatedMin = {};
      if (minPrice) filter.estimatedMin.$gte = Number(minPrice);
      if (maxPrice) filter.estimatedMin.$lte = Number(maxPrice);
    }

    const [listings, total] = await Promise.all([
      Listing.find(filter)
        .select("-userPhone") // never expose phone number in list view
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Listing.countDocuments(filter),
    ]);

    res.json({
      listings,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});


router.get("/:id", async (req, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    res.json(listing);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/status", async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowed = ["active", "sold", "swapped", "removed"];
    if (!allowed.includes(status)) {
      return res
        .status(400)
        .json({ error: `status must be one of: ${allowed.join(", ")}` });
    }

    const listing = await Listing.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    );
    if (!listing) return res.status(404).json({ error: "Listing not found" });

    res.json(listing);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
