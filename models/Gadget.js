const mongoose = require("mongoose");

// ─── Gadget Model ─────────────────────────────────────────────────────────────
const GadgetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    brand: { type: String, required: true, trim: true, maxlength: 50 },
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
    currentPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "NGN", maxlength: 10 },
    specs: { type: Map, of: String },
    imageUrl: { type: String, maxlength: 500 },
    tags: {
      type: [String],
      validate: {
        validator: (v) => v.length <= 10,
        message: "Tags cannot exceed 10 items",
      },
    },
    priceHistory: [
      {
        price: { type: Number, min: 0 },
        recordedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

GadgetSchema.index({ name: "text", brand: "text", tags: "text" });

const Gadget = mongoose.model("Gadget", GadgetSchema);

// ─── Device Model ─────────────────────────────────────────────────────────────
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
    purchasePrice: { type: Number, min: 0 },
    purchaseDate: Date,
    condition: {
      type: String,
      enum: ["new", "like-new", "good", "fair", "poor"],
      default: "good",
    },
    estimatedValue: { type: Number, min: 0 },
    notes: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

const Device = mongoose.model("Device", DeviceSchema);

module.exports = { Gadget, Device };
