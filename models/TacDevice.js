const mongoose = require("mongoose");

// Type Allocation Code — the first 8 digits of an IMEI, assigned per
// make/model. Our own table, filled by CSV import (scripts/importTac.js),
// admins, and listings admins approve (source "learned").
const TacDeviceSchema = new mongoose.Schema(
  {
    tac: { type: String, required: true, unique: true, match: /^\d{8}$/ },
    brand: { type: String, required: true, trim: true, maxlength: 50 },
    model: { type: String, required: true, trim: true, maxlength: 100 },
    deviceType: {
      type: String,
      enum: ["phone", "tablet", "wearable", "other"],
      default: "phone",
    },
    source: {
      type: String,
      enum: ["manual", "import", "learned"],
      default: "manual",
    },
    active: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

TacDeviceSchema.index({ brand: 1, model: 1 });

module.exports = mongoose.model("TacDevice", TacDeviceSchema);
