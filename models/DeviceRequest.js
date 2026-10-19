const mongoose = require("mongoose");
const crypto = require("crypto");

// A customer request sent to matching vendors instead of TechNest staff
// calling round: "I want to buy / sell / swap / repair / find an accessory".
// Matched vendors send offers; the customer picks one, or the best offer is
// picked automatically when the request closes (autoSelect). TechNest then
// arranges the deal — contacts are never shared directly.
//
// Status flow: open → accepted → completed, or open → expired (no offer
// picked in time) / cancelled.
const OfferSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    vendorName: { type: String, required: true },
    // buy/accessory: price to the customer · repair: repair cost ·
    // sell: what the vendor pays · swap: top-up the customer pays (0 = even)
    price: { type: Number, required: true, min: 0 },
    message: { type: String, trim: true, maxlength: 500, default: null },
    eta: { type: String, trim: true, maxlength: 60, default: null }, // e.g. "Same day"
    warrantyDays: { type: Number, min: 0, max: 730, default: 0 },
    status: {
      type: String,
      enum: ["active", "withdrawn", "accepted", "declined"],
      default: "active",
    },
  },
  { timestamps: true }
);

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newReference = () =>
  "RQ-" + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");

const DeviceRequestSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true, default: newReference },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    customerName: { type: String, required: true },

    type: { type: String, enum: ["buy", "sell", "swap", "repair", "accessory"], required: true },
    category: {
      type: String,
      enum: ["phone", "laptop", "tablet", "wearable", "gaming", "audio", "camera", "accessory", "other"],
      required: true,
    },
    deviceName: { type: String, required: true, trim: true, maxlength: 150 },
    storage: { type: String, trim: true, maxlength: 30, default: null },
    condition: { type: String, trim: true, maxlength: 300, default: null }, // sell/swap
    wantedDevice: { type: String, trim: true, maxlength: 150, default: null }, // swap
    issue: { type: String, trim: true, maxlength: 500, default: null }, // repair
    repairServiceId: { type: String, default: null }, // data/repairs.json id
    snapchatStatus: { type: String, enum: ["works", "banned", "unknown"], default: "unknown" },
    imeiLast4: { type: String, default: null },
    description: { type: String, trim: true, maxlength: 1000, default: null },
    images: { type: [String], default: [] },
    budgetMin: { type: Number, min: 0, default: null },
    budgetMax: { type: Number, min: 0, default: null },

    state: { type: String, required: true },
    city: { type: String, trim: true, maxlength: 60, default: null },

    autoSelect: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },

    status: {
      type: String,
      enum: ["open", "accepted", "completed", "cancelled", "expired"],
      default: "open",
    },
    matchedVendors: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    offers: { type: [OfferSchema], default: [] },
    acceptedOffer: { type: mongoose.Schema.Types.ObjectId, default: null },
    acceptedVendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    autoSelected: { type: Boolean, default: false },
    acceptedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    adminNotes: { type: String, trim: true, maxlength: 1000, default: null },

    // Set when staff complete it (utils/finance.js): the vendor owes
    // TechNest the commission until it's marked collected
    finalPrice: { type: Number, min: 0, default: null },
    commission: { type: Number, min: 0, default: null },
    commissionStatus: { type: String, enum: ["none", "due", "collected"], default: "none" },
    commissionReference: { type: String, trim: true, maxlength: 100, default: null },
    commissionCollectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

DeviceRequestSchema.index({ customer: 1, createdAt: -1 });
DeviceRequestSchema.index({ matchedVendors: 1, status: 1, createdAt: -1 });
DeviceRequestSchema.index({ status: 1, expiresAt: 1 });
DeviceRequestSchema.index({ acceptedVendor: 1, status: 1 });
DeviceRequestSchema.index({ status: 1, completedAt: -1 });

module.exports = mongoose.model("DeviceRequest", DeviceRequestSchema);
