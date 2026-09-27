const Order = require("../models/Order");
const Listing = require("../models/Listing");
const Transaction = require("../models/Transaction");
const Notification = require("../models/Notification");
const paystack = require("./paystack");

// Applies a Paystack verification result to an order. Called from both the
// callback-page verify endpoint and the webhook, so it must be idempotent:
// the pending → paid/failed flip is a single conditional update, and only
// the caller that wins it runs the side effects.
const settleOrder = async (reference) => {
  const order = await Order.findOne({ reference });
  if (!order) return { error: "Order not found.", status: 404 };
  if (order.status !== "pending") return { order };

  const result = await paystack.verifyTransaction(reference);
  if (result.error) return { error: result.error, status: 502 };

  // Paystack reports "abandoned"/"ongoing" for checkouts the buyer never
  // finished — leave those pending so a later retry or webhook can settle them.
  if (!result.paid && result.status !== "failed" && result.status !== "reversed")
    return { order };

  // Guard against a reference being reused for a different amount
  const amountMatches = result.amountKobo === Math.round(order.amount * 100);
  const nextStatus = result.paid && amountMatches ? "paid" : "failed";

  const updated = await Order.findOneAndUpdate(
    { _id: order._id, status: "pending" },
    {
      status: nextStatus,
      paidAt: nextStatus === "paid" ? new Date() : null,
    },
    { returnDocument: "after" }
  );
  // Someone else settled it between our read and write
  if (!updated) return { order: await Order.findById(order._id) };

  if (nextStatus === "paid") await applyPaidEffects(updated);
  return { order: updated };
};

const applyPaidEffects = async (order) => {
  const notifications = [
    {
      recipientType: "specific",
      recipient: order.buyer,
      type: "order_paid",
      title: "Payment received",
      message: `We've received ₦${order.amount.toLocaleString()} for ${
        order.items[0]?.name || "your order"
      }.`,
      order: order._id,
    },
  ];

  if (order.kind === "listing" && order.listing) {
    const listing = await Listing.findOneAndUpdate(
      { _id: order.listing, status: "active" },
      { status: "sold" },
      { returnDocument: "after" }
    );
    // Close out any open swap/buy requests on a listing that's now gone
    await Transaction.updateMany(
      { listing: order.listing, status: { $in: ["pending", "accepted"] } },
      { status: "cancelled" }
    );
    if (order.seller) {
      notifications.push({
        recipientType: "specific",
        recipient: order.seller,
        type: "listing_sold",
        title: "Your listing sold",
        message: `${order.buyerName} paid for your ${
          listing?.deviceName || order.items[0]?.name
        }. ₦${(order.sellerAmount || 0).toLocaleString()} is on its way to your bank.`,
        listing: order.listing,
        order: order._id,
      });
    }
  }

  if (order.kind === "swap" && order.transaction) {
    const txn = await Transaction.findByIdAndUpdate(
      order.transaction,
      { topUpPaid: true },
      { returnDocument: "after" }
    );
    if (txn) {
      notifications.push({
        recipientType: "specific",
        recipient: txn.seller,
        type: "transaction_update",
        title: "Swap top-up paid",
        message: `${txn.buyerName} paid the ₦${txn.topUpAmount.toLocaleString()} difference for your ${txn.listingDeviceName}.`,
        listing: txn.listing,
        transaction: txn._id,
      });
    }
  }

  await Notification.insertMany(notifications);
};

module.exports = { settleOrder };
