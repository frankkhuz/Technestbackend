const mongoose = require("mongoose");

const InventoryItemSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    deviceName: { type: String, required: true, trim: true, maxlength: 150 },
    storage: { type: String, trim: true, maxlength: 30, default: null },
    category: { type: String, trim: true, maxlength: 40, default: null },
    buyPrice: { type: Number, required: true, min: 0 },
    sellPrice: { type: Number, required: true, min: 0 },
    condition: {
      type: String,
      enum: ["New", "UK Used", "Refurbished", "Nigerian Used"],
      default: "UK Used",
    },
    status: {
      type: String,
      enum: ["in_stock", "sold"],
      default: "in_stock",
    },
    soldAt: { type: Date, default: null },
  },
  { timestamps: true }
);

InventoryItemSchema.index({ vendor: 1, status: 1 });

module.exports = mongoose.model("InventoryItem", InventoryItemSchema);
