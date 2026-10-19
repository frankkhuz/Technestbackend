const mongoose = require("mongoose");
const crypto = require("crypto");

// A complaint about a deal ("not as described", "never arrived"…), worked
// out between the two sides with TechNest staff deciding (routes/disputes.js).
//
// Status flow: open → investigating → resolved / rejected.
const MessageSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["raiser", "respondent", "staff"], required: true },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    evidence: { type: [String], default: [] },
  },
  { timestamps: true }
);

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newReference = () =>
  "DP-" + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");

const DisputeSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true, default: newReference },
    raisedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // The other side; null when TechNest itself sold the item (catalog order)
    against: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    source: {
      type: { type: String, enum: ["device_request", "transaction", "order_request"], required: true },
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
      label: { type: String, default: null },
    },

    reason: {
      type: String,
      enum: ["not_as_described", "faulty", "not_delivered", "wrong_item", "stolen_or_locked", "other"],
      required: true,
    },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    evidence: { type: [String], default: [] },
    messages: { type: [MessageSchema], default: [] },

    status: { type: String, enum: ["open", "investigating", "resolved", "rejected"], default: "open" },
    resolution: {
      type: String,
      enum: ["refund", "partial_refund", "replacement", "repair", "return_and_refund", "no_action", null],
      default: null,
    },
    resolutionNote: { type: String, trim: true, maxlength: 1000, default: null },
    refundAmount: { type: Number, min: 0, default: null },
    resolvedAt: { type: Date, default: null },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

DisputeSchema.index({ raisedBy: 1, createdAt: -1 });
DisputeSchema.index({ against: 1, createdAt: -1 });
DisputeSchema.index({ status: 1, createdAt: -1 });
DisputeSchema.index({ "source.type": 1, "source.id": 1 });

module.exports = mongoose.model("Dispute", DisputeSchema);
