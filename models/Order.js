const mongoose = require("mongoose");

// One checkout = one order. Covers all three ways money changes hands:
//   - "phone"/"gadget": catalog items bought from /buy (the cart)
//   - "listing":        a marketplace listing bought from another user
//   - "swap":           the price-difference top-up on a swap request
const LineItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true }, // product slug, listing id, or transaction id
    itemType: {
      type: String,
      enum: ["phone", "gadget", "listing", "swap"],
      required: true,
    },
    name: { type: String, required: true },
    spec: { type: String, default: null },
    condition: {
      type: String,
      enum: ["uk-used", "brand-new"],
      default: "uk-used",
    },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 20 },
  },
  { _id: false }
);

const OrderSchema = new mongoose.Schema(
  {
    // Paystack reference — "TN-<order _id>". Set right after insert.
    reference: { type: String, unique: true, sparse: true },

    buyer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    kind: {
      type: String,
      enum: ["cart", "listing", "swap"],
      required: true,
    },

    items: {
      type: [LineItemSchema],
      validate: {
        validator: (v) => v.length >= 1 && v.length <= 50,
        message: "An order must have between 1 and 50 items",
      },
    },
    amount: { type: Number, required: true, min: 0 },

    // Listing purchases only — how the charge splits between seller and platform
    listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", default: null },
    seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    sellerAmount: { type: Number, default: null },
    platformFee: { type: Number, default: null },
    subaccountCode: { type: String, default: null },

    // Swap top-ups only
    transaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
      default: null,
    },

    buyerName: { type: String, required: true, trim: true, maxlength: 100 },
    buyerEmail: { type: String, required: true, trim: true, maxlength: 150 },
    buyerPhone: { type: String, required: true, trim: true, maxlength: 20 },
    deliveryAddress: { type: String, required: true, trim: true, maxlength: 500 },

    status: {
      type: String,
      enum: ["pending", "paid", "failed", "cancelled"],
      default: "pending",
    },
    paidAt: { type: Date, default: null },

    // Physical delivery progress, managed by admins once an order is paid
    fulfillmentStatus: {
      type: String,
      enum: ["unfulfilled", "processing", "shipped", "delivered"],
      default: "unfulfilled",
    },
  },
  { timestamps: true }
);

OrderSchema.index({ buyer: 1, createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });

// Matches the frontend's Order type (app/lib/orders.ts). The top-level
// itemId/itemName/etc. mirror the first line item for backward compat with
// the checkout callback page.
OrderSchema.methods.toClient = function () {
  const first = this.items[0] || {};
  const itemName =
    this.items.length <= 1
      ? first.name
      : `${first.name} + ${this.items.length - 1} more item${
          this.items.length > 2 ? "s" : ""
        }`;

  return {
    id: String(this._id),
    reference: this.reference,
    kind: this.kind,
    itemId: first.itemId,
    itemType: first.itemType,
    itemName,
    itemSpec: this.items.length === 1 ? first.spec || undefined : undefined,
    condition: first.condition,
    amount: this.amount,
    items: this.items.map((i) => ({
      itemId: i.itemId,
      itemType: i.itemType,
      name: i.name,
      spec: i.spec || undefined,
      condition: i.condition,
      unitPrice: i.unitPrice,
      quantity: i.quantity,
    })),
    sellerId: this.seller ? String(this.seller._id || this.seller) : undefined,
    sellerAmount: this.sellerAmount ?? undefined,
    platformFee: this.platformFee ?? undefined,
    transactionId: this.transaction ? String(this.transaction) : undefined,
    buyerName: this.buyerName,
    buyerEmail: this.buyerEmail,
    buyerPhone: this.buyerPhone,
    deliveryAddress: this.deliveryAddress,
    status: this.status,
    fulfillmentStatus: this.fulfillmentStatus,
    paidAt: this.paidAt ? this.paidAt.toISOString() : null,
    createdAt: this.createdAt.toISOString(),
    updatedAt: this.updatedAt.toISOString(),
  };
};

module.exports = mongoose.model("Order", OrderSchema);
