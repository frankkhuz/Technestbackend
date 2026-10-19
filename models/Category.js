const mongoose = require("mongoose");

// A catalog category and the filters it offers (see utils/categories.js).
// Two levels: a group (parent null, e.g. "audio") and its children
// (e.g. "headphones"). Product.category holds the slug.
const AttributeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, match: /^[a-z][a-zA-Z0-9]*$/, maxlength: 40 },
    label: { type: String, required: true, trim: true, maxlength: 60 },
    type: { type: String, enum: ["select", "multiselect", "number", "boolean", "text"], required: true },
    options: { type: [String], default: [] },
    unit: { type: String, trim: true, maxlength: 20, default: null },
    filterable: { type: Boolean, default: true },
  },
  { _id: false }
);

const CategorySchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]+$/, maxlength: 60 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    parent: { type: String, default: null }, // parent slug, or null for a top-level group
    description: { type: String, trim: true, maxlength: 300, default: null },
    image: { type: String, trim: true, maxlength: 500, default: null },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    attributes: { type: [AttributeSchema], default: [] },
  },
  { timestamps: true }
);

CategorySchema.index({ parent: 1, order: 1 });

CategorySchema.methods.toClient = function () {
  return {
    slug: this.slug,
    name: this.name,
    parent: this.parent,
    description: this.description || undefined,
    image: this.image || undefined,
    order: this.order,
    isActive: this.isActive,
    attributes: this.attributes.map((a) => ({
      key: a.key,
      label: a.label,
      type: a.type,
      options: a.options.length ? a.options : undefined,
      unit: a.unit || undefined,
      filterable: a.filterable,
    })),
  };
};

module.exports = mongoose.model("Category", CategorySchema);
