const mongoose = require("mongoose");

const ListingSchema = new mongoose.Schema(
  {
    userName: { type: String, required: true, trim: true, maxlength: 100 },
    userPhone: { type: String, required: true, trim: true, maxlength: 20 },

    deviceName: { type: String, required: true, trim: true, maxlength: 120 },
    deviceCategory: {
      type: String,
      enum: ["phone", "laptop"],
      required: true,
    },
    subType: {
      type: String,
      enum: ["iphone", "android", "macbook", "windows", "linux", "gaming"],
      required: true,
    },
    storage: { type: String, trim: true, maxlength: 20 },
    batteryHealth: { type: String, maxlength: 5 },
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
    mediaCount: { type: Number, default: 0, min: 0 },
    imeiVerified: { type: Boolean, default: false },

    estimatedMin: { type: Number, required: true, min: 0 },
    estimatedMax: { type: Number, required: true, min: 0 },

    listingType: {
      type: String,
      enum: ["sell", "swap"],
      required: true,
      default: "sell",
    },
    wantedDevice: { type: String, trim: true, maxlength: 150, default: null },

    status: {
      type: String,
      enum: ["active", "sold", "swapped", "removed"],
      default: "active",
    },

    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

ListingSchema.index({ status: 1, createdAt: -1 });
ListingSchema.index({ deviceCategory: 1, status: 1 });
ListingSchema.index({ listingType: 1, status: 1 });
ListingSchema.index({ deviceName: "text" });

module.exports = mongoose.model("Listing", ListingSchema);
