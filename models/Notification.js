const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    // Broadcast notifications (recipientType: all_vendors) have no
    // recipient set — GET /api/notifications matches those against the
    // requesting user's userType instead of a specific _id.
    recipientType: {
      type: String,
      enum: ["all_users", "all_vendors", "specific"],
      required: true,
    },
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    type: {
      type: String,
      enum: [
        "new_cash_listing",
        "new_swap_request",
        "offer_received",
        "bid_placed",
        "offer_accepted",
        "swap_request",
        "buy_request",
        "transaction_update",
        "order_paid",
        "listing_sold",
      ],
      required: true,
    },
    title: { type: String, required: true, maxlength: 150 },
    message: { type: String, required: true, maxlength: 500 },
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Listing",
      default: null,
    },
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },
    // read status is per-recipient for targeted notifications, but for
    // broadcast notifications this is necessarily shared across everyone
    // who receives them — acceptable tradeoff for a marketplace this size,
    // revisit with a per-user read-receipts collection if that matters later
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

NotificationSchema.index({ recipientType: 1, recipient: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", NotificationSchema);
