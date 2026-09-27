const mongoose = require("mongoose");

// A deal between two users over one marketplace listing.
//   - "swap": buyer offers their own device in exchange for the listing
//   - "buy":  buyer asks to buy the listing outright (arranged offline)
//   - "sell": created when a listing owner accepts a vendor's bid — the
//             listing owner is the seller, the vendor is the buyer
//
// Status flow: pending → accepted → completed, or → cancelled at any
// point before completion. Only the seller can accept a pending request.
const SwapDetailsSchema = new mongoose.Schema(
  {
    offeredDeviceId: { type: String, default: null },
    offeredDeviceName: { type: String, required: true },
    offeredStorage: { type: String, default: null },
    // Condition report as submitted, kept so the seller can see what they're
    // being offered and why it was valued the way it was
    offeredCondition: { type: mongoose.Schema.Types.Mixed, default: null },
    offeredValuation: { type: Number, required: true, min: 0 },
    // "catalog" = priced by the server from the known device list,
    // "custom"  = user-entered price for a device we don't have data for
    valuationSource: {
      type: String,
      enum: ["catalog", "custom"],
      default: "catalog",
    },
    targetPriceMin: { type: Number, required: true, min: 0 },
    targetPriceMax: { type: Number, required: true, min: 0 },
    // listing midpoint - offeredValuation, from the buyer's point of view:
    // >0 means the buyer tops up ("pay_extra"), <0 means the seller owes
    // the buyer the difference ("refund"). Computed server-side.
    priceDifference: { type: Number, required: true },
    direction: {
      type: String,
      enum: ["pay_extra", "refund", "even"],
      required: true,
    },
  },
  { _id: false }
);

const TransactionSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["buy", "sell", "swap"], required: true },

    listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", required: true },
    listingDeviceName: { type: String, required: true },
    listingStorage: { type: String, default: null },

    seller: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    sellerName: { type: String, required: true },
    buyer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    buyerName: { type: String, required: true },
    buyerPhone: { type: String, default: null },

    // Agreed cash price, for buy/sell deals
    agreedPrice: { type: Number, min: 0, default: null },
    // The vendor bid this came from, for "sell" transactions
    bid: { type: mongoose.Schema.Types.ObjectId, default: null },

    swapDetails: { type: SwapDetailsSchema, default: null },

    // Swap top-up: when the buyer owes money, they pay it through checkout
    // (Order kind "swap") and this flips to paid on verification.
    topUpAmount: { type: Number, min: 0, default: 0 },
    topUpPaid: { type: Boolean, default: false },

    message: { type: String, trim: true, maxlength: 500, default: null },

    status: {
      type: String,
      enum: ["pending", "accepted", "completed", "cancelled"],
      default: "pending",
    },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

TransactionSchema.index({ buyer: 1, createdAt: -1 });
TransactionSchema.index({ seller: 1, createdAt: -1 });
TransactionSchema.index({ listing: 1, status: 1 });

TransactionSchema.statics.VALID_TRANSITIONS = {
  pending: ["accepted", "cancelled"],
  accepted: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

// Matches the frontend's Transaction type (app/lib/transactions.ts)
TransactionSchema.methods.toClient = function () {
  const sd = this.swapDetails;
  return {
    id: String(this._id),
    type: this.type,
    listingId: String(this.listing._id || this.listing),
    listingDeviceName: this.listingDeviceName,
    listingStorage: this.listingStorage || undefined,
    sellerId: String(this.seller._id || this.seller),
    sellerName: this.sellerName,
    buyerId: String(this.buyer._id || this.buyer),
    buyerName: this.buyerName,
    buyerPhone: this.buyerPhone || undefined,
    agreedPrice: this.agreedPrice ?? undefined,
    status: this.status,
    message: this.message || undefined,
    swapDetails: sd
      ? {
          offeredDeviceName: sd.offeredDeviceName,
          offeredStorage: sd.offeredStorage || undefined,
          offeredCondition: sd.offeredCondition || undefined,
          offeredValuation: sd.offeredValuation,
          valuationSource: sd.valuationSource,
          targetPriceMin: sd.targetPriceMin,
          targetPriceMax: sd.targetPriceMax,
          priceDifference: sd.priceDifference,
          direction: sd.direction,
        }
      : undefined,
    topUpAmount: this.topUpAmount,
    topUpPaid: this.topUpPaid,
    createdAt: this.createdAt.toISOString(),
    updatedAt: this.updatedAt.toISOString(),
  };
};

module.exports = mongoose.model("Transaction", TransactionSchema);
