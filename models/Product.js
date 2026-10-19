const mongoose = require("mongoose");

// Catalog items shown on the /buy page. These used to be hardcoded in the
// frontend (app/data/gadget.ts) — they now live here so admins can edit
// prices/stock and so checkout can price items server-side.
//
// `slug` is the stable public id (e.g. "iphone-17-pro-max"). The frontend
// cart stores it as `itemId`, so it must never change once an item is live.
const ProductSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 100,
      match: /^[a-z0-9-]+$/,
    },
    type: { type: String, enum: ["phone", "gadget"], required: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    brand: { type: String, required: true, trim: true, maxlength: 50 },

    // Phones: flagship | mid-range | budget
    // Gadgets: camera | watch | stylus | keyboard | audio | tablet | ...
    category: { type: String, required: true, trim: true, maxlength: 50 },

    image: { type: String, trim: true, maxlength: 500, default: null },
    storage: { type: [String], default: [] },
    colors: { type: [String], default: [] },
    ram: { type: String, trim: true, maxlength: 30, default: null },
    spec: { type: String, trim: true, maxlength: 150, default: null },
    badge: { type: String, trim: true, maxlength: 30, default: null },
    tags: { type: [String], default: [] },

    priceUkUsed: { type: Number, required: true, min: 0 },
    priceBrandNew: { type: Number, required: true, min: 0 },

    // Filter values for this product's category, e.g. { connectivity:
    // "Wireless", noiseCancelling: true } — validated against the
    // category's attribute definitions (utils/categories.js)
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Flash sale: the sale prices apply only between startsAt and endsAt,
    // checked on every read, so nothing has to switch it on or off
    sale: {
      type: {
        priceUkUsed: { type: Number, min: 0, default: null },
        priceBrandNew: { type: Number, min: 0, default: null },
        startsAt: { type: Date, required: true },
        endsAt: { type: Date, required: true },
        label: { type: String, trim: true, maxlength: 30, default: "Flash Sale" },
      },
      default: null,
    },

    inStock: { type: Boolean, default: true },
    // Optional unit count. null = not counted (inStock is set by hand);
    // when set, inStock follows it and sales take it down (utils/stock.js)
    stockQuantity: { type: Number, min: 0, default: null },
    // Soft-delete: hidden from the catalog but kept so old orders (and
    // "buy again") can still resolve the slug to a name.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ProductSchema.index({ type: 1, category: 1, isActive: 1 });
ProductSchema.index({ name: "text", brand: "text", tags: "text" });
ProductSchema.index({ "sale.endsAt": 1, "sale.startsAt": 1 });

// A counted product is in stock exactly while it has units left
ProductSchema.pre("save", function () {
  if (this.stockQuantity !== null && this.stockQuantity !== undefined) this.inStock = this.stockQuantity > 0;
});

ProductSchema.methods.saleActive = function (now = new Date()) {
  const s = this.sale;
  return !!(s && s.startsAt <= now && s.endsAt > now && (s.priceUkUsed || s.priceBrandNew));
};

// Everything that charges or quotes a price goes through here, so a live
// flash sale is honoured everywhere
ProductSchema.methods.priceFor = function (condition) {
  const brandNew = condition === "brand-new";
  if (this.saleActive()) {
    const salePrice = brandNew ? this.sale.priceBrandNew : this.sale.priceUkUsed;
    if (salePrice) return salePrice;
  }
  return brandNew ? this.priceBrandNew : this.priceUkUsed;
};

// Shaped to match the frontend's BuyPhone / BuyGadget types so the /buy
// page can swap its static import for this response with minimal changes.
ProductSchema.methods.toClient = function () {
  const base = {
    id: this.slug,
    _id: this._id,
    type: this.type,
    name: this.name,
    brand: this.brand,
    priceUkUsed: this.priceUkUsed,
    priceBrandNew: this.priceBrandNew,
    badge: this.badge || undefined,
    inStock: this.inStock,
    // Only shown when counted — "Only 3 left" when it's low
    stockQuantity: this.stockQuantity ?? undefined,
    lowStock: this.stockQuantity != null && this.stockQuantity > 0 && this.stockQuantity <= 5 ? true : undefined,
    isActive: this.isActive,
    attributes: this.attributes && Object.keys(this.attributes).length ? this.attributes : undefined,
    // Show the base price struck through next to the sale price while active
    sale: this.sale
      ? {
          active: this.saleActive(),
          priceUkUsed: this.sale.priceUkUsed || undefined,
          priceBrandNew: this.sale.priceBrandNew || undefined,
          startsAt: this.sale.startsAt.toISOString(),
          endsAt: this.sale.endsAt.toISOString(),
          label: this.sale.label,
        }
      : undefined,
  };

  if (this.type === "phone") {
    return {
      ...base,
      image: this.image || undefined,
      storage: this.storage,
      ram: this.ram || undefined,
      category: this.category,
      color: this.colors.length ? this.colors : undefined,
    };
  }

  return {
    ...base,
    category: this.category,
    gadgetCategory: this.category,
    spec: this.spec || undefined,
    tags: this.tags.length ? this.tags : undefined,
  };
};

module.exports = mongoose.model("Product", ProductSchema);
