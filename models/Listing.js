const mongoose = require("mongoose");

const BidSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    vendorName: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    message: { type: String, maxlength: 500 },
  },
  { timestamps: true, _id: true }
);

const ListingSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // Seller contact info (kept denormalized from owner so listings still
    // display correctly even if the seller edits their profile later)
    userName: { type: String, required: true, trim: true, maxlength: 100 },
    userPhone: { type: String, required: true, trim: true, maxlength: 20 },

    // Device details
    deviceName: { type: String, required: true, trim: true, maxlength: 150 },
    deviceCategory: {
      type: String,
      required: true,
      enum: ["phone", "laptop", "tablet", "wearable", "accessory", "other"],
    },
    subType: { type: String, required: true, trim: true, maxlength: 50 },
    storage: { type: String, trim: true, maxlength: 30 },
    batteryHealth: { type: String, trim: true, maxlength: 10 },
    simType: {
      type: String,
      enum: ["physical", "esim-unlocked", "locked", null],
      default: null,
    },
    faceIdStatus: {
      type: String,
      enum: ["working", "broken", null],
      default: null,
    },
    repairs: { type: [String], default: [] },
    description: { type: String, trim: true, maxlength: 1000, default: null },

    // Media — Cloudinary URLs only, never raw image data. mediaCount is
    // kept separately since it also counts videos, which aren't uploaded
    // to Cloudinary in the current flow.
    images: {
      type: [String],
      validate: {
        validator: (v) => v.length <= 10,
        message: "Cannot exceed 10 images",
      },
      default: [],
    },
    mediaCount: { type: Number, default: 0, min: 0 },

    imeiVerified: { type: Boolean, default: false },

    estimatedMin: { type: Number, required: true, min: 0 },
    estimatedMax: { type: Number, required: true, min: 0 },

    listingType: {
      type: String,
      enum: ["sell", "swap"],
      default: "sell",
    },
    wantedDevice: { type: String, trim: true, maxlength: 150, default: null },

    bids: { type: [BidSchema], default: [] },

    // Admin moderation — new listings start out invisible to the public
    // marketplace (GET /api/listings defaults to status=active) until an
    // admin approves them. "open" is used elsewhere in the codebase
    // (vendor dashboard bid gating) to mean "not yet sold/swapped/removed"
    // and is distinct from moderation status below.
    status: {
      type: String,
      enum: [
        "pending_review",
        "active",
        "rejected",
        "sold",
        "swapped",
        "removed",
      ],
      default: "pending_review",
    },
    rejectionReason: { type: String, maxlength: 300, default: null },

    // Latest AI review for admins (optional — only when AI is available)
    aiReview: {
      type: {
        summary: String,
        recommendation: { type: String, enum: ["approve", "check", "reject"] },
        flags: [{ _id: false, severity: String, message: String }],
        photosMatchDevice: String,
        at: Date,
      },
      default: null,
    },
  },
  { timestamps: true }
);

ListingSchema.index({ deviceName: "text", deviceCategory: "text" });
ListingSchema.index({ status: 1, createdAt: -1 });
ListingSchema.index({ owner: 1 });

module.exports = mongoose.model("Listing", ListingSchema);
