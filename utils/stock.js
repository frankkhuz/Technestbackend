// Counted stock (Product.stockQuantity): checks before an order and takes
// units off when a sale completes. Products without a count are untouched.
const Product = require("../models/Product");

/** @returns {string|null} why this quantity can't be ordered */
const stockProblem = (product, quantity) =>
  product.stockQuantity != null && quantity > product.stockQuantity
    ? product.stockQuantity === 0
      ? `${product.name} is out of stock.`
      : `Only ${product.stockQuantity} ${product.name} left.`
    : null;

/** Takes sold units off counted products; marks them out of stock at 0. */
const takeFromStock = async (lines) => {
  for (const { itemId, quantity } of lines) {
    const p = await Product.findOneAndUpdate(
      { slug: itemId, stockQuantity: { $ne: null } },
      [{ $set: { stockQuantity: { $max: [0, { $subtract: ["$stockQuantity", quantity] }] } } }],
      { returnDocument: "after", updatePipeline: true }
    );
    if (p && p.stockQuantity === 0 && p.inStock) await Product.updateOne({ _id: p._id }, { inStock: false });
  }
};

module.exports = { stockProblem, takeFromStock };
