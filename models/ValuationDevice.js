const mongoose = require("mongoose");

// A device the valuation engine can price (used by /value, swaps and the
// admin price tools). Base prices come from dealer quotes, or are typed in
// by an admin. Seeded automatically from data/valuationDevices.json +
// data/marketPrices.json the first time the server starts on an empty DB.
const QuoteSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, trim: true, maxlength: 100 },
    price: { type: Number, required: true, min: 0 },
    sim: {
      type: String,
      enum: ["phys+esim", "esim", "dual-sim"],
      default: "phys+esim",
    },
    condition: { type: String, enum: ["uk-used", "new"], default: "uk-used" },
    note: { type: String, maxlength: 200, default: null },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ValuationDeviceSchema = new mongoose.Schema(
  {
    deviceId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: /^[a-z0-9-]+$/,
      maxlength: 80,
    },
    category: { type: String, enum: ["phone", "laptop"], required: true },
    subType: {
      type: String,
      enum: ["iphone", "android", "macbook", "windows", "linux", "gaming"],
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    storage: { type: String, trim: true, maxlength: 30, default: "" },
    ram: { type: String, default: null },
    chip: { type: String, default: null },
    display: { type: String, default: null },

    quotes: { type: [QuoteSchema], default: [] },

    // "market": computed from quotes; "manual": typed in by an admin (quotes
    // ignored until they switch back); "legacy": old hand-entered price with
    // no quotes behind it
    priceSource: {
      type: String,
      enum: ["market", "manual", "legacy"],
      default: "legacy",
    },
    basis: { type: String, default: null }, // which quote tier set the price
    baseMin: { type: Number, required: true, min: 0 },
    baseMax: { type: Number, required: true, min: 0 },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ValuationDeviceSchema.index({ category: 1, subType: 1, isActive: 1 });

ValuationDeviceSchema.methods.toClient = function ({ withQuotes = false } = {}) {
  const out = {
    id: this.deviceId,
    category: this.category,
    subType: this.subType,
    name: this.name,
    storage: this.storage,
    baseMin: this.baseMin,
    baseMax: this.baseMax,
    ram: this.ram || undefined,
    chip: this.chip || undefined,
    display: this.display || undefined,
    priceSource: this.priceSource,
    basis: this.basis || undefined,
    isActive: this.isActive,
  };
  if (withQuotes) {
    out.quotes = this.quotes.map((q) => ({
      id: String(q._id),
      source: q.source,
      price: q.price,
      sim: q.sim,
      condition: q.condition,
      note: q.note || undefined,
      addedAt: q.addedAt,
    }));
    out.updatedAt = this.updatedAt;
  }
  return out;
};

module.exports = mongoose.model("ValuationDevice", ValuationDeviceSchema);
