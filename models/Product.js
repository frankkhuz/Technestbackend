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

    inStock: { type: Boolean, default: true },
    // Soft-delete: hidden from the catalog but kept so old orders (and
    // "buy again") can still resolve the slug to a name.
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ProductSchema.index({ type: 1, category: 1, isActive: 1 });
ProductSchema.index({ name: "text", brand: "text", tags: "text" });

ProductSchema.methods.priceFor = function (condition) {
  return condition === "brand-new" ? this.priceBrandNew : this.priceUkUsed;
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
    isActive: this.isActive,
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
    gadgetCategory: this.category,
    spec: this.spec || undefined,
    tags: this.tags.length ? this.tags : undefined,
  };
};

module.exports = mongoose.model("Product", ProductSchema);
