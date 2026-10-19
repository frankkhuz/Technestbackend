const mongoose = require("mongoose");
const crypto = require("crypto");

// A buyer asking to buy through TechNest on WhatsApp, while online payment
// is "coming soon". TechNest staff follow up and arrange payment/delivery.
//
// Status flow: new → in_progress (staff talking to the buyer; a marketplace
// listing is held for them) → completed, or → cancelled at any point.
const ItemSchema = new mongoose.Schema(
  {
    itemType: { type: String, enum: ["product", "listing"], required: true },
    itemId: { type: String, required: true }, // product slug or listing id
    name: { type: String, required: true },
    spec: { type: String, default: null },
    condition: { type: String, default: null },
    unitPrice: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 20 },
  },
  { _id: false }
);

// Short, easy to read out on a call: no 0/O or 1/I
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const newReference = () =>
  "TN-" + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");

const OrderRequestSchema = new mongoose.Schema(
  {
    reference: { type: String, unique: true, default: newReference },
    channel: { type: String, enum: ["whatsapp"], default: "whatsapp" },

    buyer: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    buyerName: { type: String, required: true, trim: true, maxlength: 100 },
    buyerPhone: { type: String, required: true, trim: true, maxlength: 20 },
    buyerEmail: { type: String, trim: true, lowercase: true, maxlength: 150, default: null },
    state: { type: String, default: null },
    note: { type: String, trim: true, maxlength: 500, default: null },

    kind: { type: String, enum: ["cart", "listing"], required: true },
    items: {
      type: [ItemSchema],
      validate: { validator: (v) => v.length >= 1 && v.length <= 50, message: "1 to 50 items" },
    },
    listing: { type: mongoose.Schema.Types.ObjectId, ref: "Listing", default: null },
    amount: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: ["new", "in_progress", "completed", "cancelled"],
      default: "new",
    },
    adminNotes: { type: String, trim: true, maxlength: 1000, default: null },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

OrderRequestSchema.index({ status: 1, createdAt: -1 });
OrderRequestSchema.index({ buyer: 1, createdAt: -1 });
OrderRequestSchema.index({ listing: 1, status: 1 });

OrderRequestSchema.methods.toClient = function () {
  return {
    id: String(this._id),
    reference: this.reference,
    channel: this.channel,
    kind: this.kind,
    items: this.items.map((i) => ({ ...i.toObject() })),
    listingId: this.listing ? String(this.listing._id || this.listing) : undefined,
    amount: this.amount,
    buyerName: this.buyerName,
    buyerPhone: this.buyerPhone,
    buyerEmail: this.buyerEmail || undefined,
    state: this.state || undefined,
    note: this.note || undefined,
    status: this.status,
    createdAt: this.createdAt.toISOString(),
    updatedAt: this.updatedAt.toISOString(),
  };
};

module.exports = mongoose.model("OrderRequest", OrderRequestSchema);
