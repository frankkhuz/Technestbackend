const mongoose = require("mongoose");

// ─── Gadget Model ─────────────────────────────────────────────────────────────
const GadgetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    brand: { type: String, required: true },
    category: {
      type: String,
      enum: [
        "smartphone",
        "laptop",
        "tablet",
        "wearable",
        "accessory",
        "other",
      ],
      default: "other",
    },
    currentPrice: { type: Number, required: true },
    currency: { type: String, default: "NGN" },
    specs: { type: Map, of: String }, // flexible key-value specs
    imageUrl: String,
    tags: [String],
    priceHistory: [
      {
        price: Number,
        recordedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

GadgetSchema.index({ name: "text", brand: "text", tags: "text" }); // full-text search

const Gadget = mongoose.model("Gadget", GadgetSchema);

// ─── Device Model (user's registered devices) ─────────────────────────────────
const DeviceSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    gadget: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Gadget",
      required: true,
    },
    purchasePrice: Number,
    purchaseDate: Date,
    condition: {
      type: String,
      enum: ["new", "like-new", "good", "fair", "poor"],
      default: "good",
    },
    estimatedValue: Number, // computed / updated periodically
    notes: String,
  },
  { timestamps: true }
);

const Device = mongoose.model("Device", DeviceSchema);

module.exports = { Gadget, Device };
