const express = require("express");
const Category = require("../models/Category");
const Product = require("../models/Product");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { expandCategory, categoryFacets } = require("../utils/categories");
const router = express.Router();

/**
 * @swagger
 * /api/categories:
 *   get:
 *     summary: Category tree for the navigation menu
 *     description: Top-level groups, each with `children`. Admins can add `?all=true` to include hidden ones.
 *     tags: [Categories]
 *     security: []
 *     responses:
 *       200:
 *         description: "data.categories: [{ slug, name, description, attributes, children: [...] }]"
 */
router.get("/", async (req, res, next) => {
  try {
    const filter = req.query.all === "true" ? {} : { isActive: true };
    const all = await Category.find(filter).sort({ order: 1, name: 1 });
    const top = all.filter((c) => !c.parent);
    sendSuccess(res, 200, "Categories fetched", {
      categories: top.map((c) => ({
        ...c.toClient(),
        children: all.filter((k) => k.parent === c.slug).map((k) => k.toClient()),
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/categories/{slug}:
 *   get:
 *     summary: One category with its filters — options with product counts, number ranges, brands and price range
 *     description: >
 *       Build the filter sidebar from `filters.attributes`: each has a
 *       `param` to send to GET /api/products (e.g. a.connectivity=Wireless),
 *       or `params` [min, max] for numbers. Counts only include products in
 *       this category (and its subcategories, for a group).
 *     tags: [Categories]
 *     security: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string, example: headphones }
 *     responses:
 *       200:
 *         description: "data: { category, parent, children, filters: { total, brands, price, attributes } }"
 *       404:
 *         description: No such category
 */
router.get("/:slug", async (req, res, next) => {
  try {
    const category = await Category.findOne({ slug: String(req.params.slug).toLowerCase(), isActive: true });
    if (!category) return sendError(res, 404, "Category not found");
    const [children, parent, slugs] = await Promise.all([
      Category.find({ parent: category.slug, isActive: true }).sort({ order: 1 }),
      category.parent ? Category.findOne({ slug: category.parent }) : null,
      expandCategory(category.slug),
    ]);
    sendSuccess(res, 200, "Category fetched", {
      category: category.toClient(),
      parent: parent ? { slug: parent.slug, name: parent.name } : null,
      children: children.map((c) => c.toClient()),
      filters: await categoryFacets(category, slugs),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Admin ───────────────────────────────────────────────────────────────────

const ATTR_TYPES = ["select", "multiselect", "number", "boolean", "text"];

// Validates admin input for a category's filters
const cleanAttributes = (input) => {
  if (!Array.isArray(input)) return { error: "attributes must be a list" };
  const seen = new Set();
  const out = [];
  for (const a of input) {
    const key = String(a?.key || "").trim();
    if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) return { error: `Filter key "${key}" must be camelCase letters/numbers, e.g. batteryLife` };
    if (seen.has(key)) return { error: `Filter "${key}" is listed twice` };
    seen.add(key);
    if (!ATTR_TYPES.includes(a.type)) return { error: `Filter "${key}" needs a type: ${ATTR_TYPES.join(", ")}` };
    const options = (Array.isArray(a.options) ? a.options : []).map((o) => String(o).trim()).filter(Boolean);
    if (["select", "multiselect"].includes(a.type) && options.length < 2) return { error: `Filter "${key}" needs at least 2 options` };
    out.push({
      key,
      label: String(a.label || key).trim().slice(0, 60),
      type: a.type,
      options: ["select", "multiselect"].includes(a.type) ? [...new Set(options)] : [],
      unit: a.unit ? String(a.unit).slice(0, 20) : null,
      filterable: a.filterable !== false,
    });
  }
  return { attributes: out };
};

const checkParent = async (parentSlug, selfSlug) => {
  if (!parentSlug) return { parent: null };
  const parent = await Category.findOne({ slug: String(parentSlug).toLowerCase() });
  if (!parent) return { error: `Parent "${parentSlug}" doesn't exist` };
  if (parent.parent) return { error: "Categories go two levels deep — pick a top-level group as the parent" };
  if (parent.slug === selfSlug) return { error: "A category can't be its own parent" };
  return { parent: parent.slug };
};

/**
 * @swagger
 * /api/categories/admin:
 *   post:
 *     summary: Admin — add a category, with its own filters
 *     tags: [Categories]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug, name]
 *             properties:
 *               slug: { type: string, example: vr-headset }
 *               name: { type: string, example: VR headsets }
 *               parent: { type: string, example: gaming }
 *               description: { type: string }
 *               image: { type: string }
 *               order: { type: integer }
 *               attributes:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     key: { type: string, example: refreshRate }
 *                     label: { type: string, example: Refresh rate }
 *                     type: { type: string, enum: [select, multiselect, number, boolean, text] }
 *                     options: { type: array, items: { type: string } }
 *                     unit: { type: string, example: Hz }
 *                     filterable: { type: boolean }
 *     responses:
 *       201:
 *         description: data.category
 *       409:
 *         description: Slug taken
 */
router.post("/admin", protect, restrictTo("admin"), verifyCsrfToken, async (req, res, next) => {
  try {
    const slug = String(req.body.slug || "").trim().toLowerCase();
    const name = String(req.body.name || "").trim();
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) return sendError(res, 400, "slug must be lowercase letters, numbers and dashes");
    if (!name) return sendError(res, 400, "name is required");
    if (await Category.exists({ slug })) return sendError(res, 409, "A category with that slug already exists");
    const p = await checkParent(req.body.parent, slug);
    if (p.error) return sendError(res, 400, p.error);
    const attrs = cleanAttributes(req.body.attributes || []);
    if (attrs.error) return sendError(res, 400, attrs.error);
    const category = await Category.create({
      slug,
      name,
      parent: p.parent,
      description: req.body.description || null,
      image: req.body.image || null,
      order: Number(req.body.order) || 0,
      attributes: attrs.attributes,
    });
    sendSuccess(res, 201, "Category created", { category: category.toClient() });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/categories/admin/{slug}:
 *   patch:
 *     summary: Admin — edit a category (name, parent, order, filters) or hide it with isActive false
 *     description: >
 *       Sending `attributes` replaces the whole filter list. Removing a
 *       filter doesn't touch products; their old value just stops being
 *       filterable. The slug can't change (products point at it).
 *     tags: [Categories]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: slug
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.category, data.productsInCategory
 */
router.patch("/admin/:slug", protect, restrictTo("admin"), verifyCsrfToken, async (req, res, next) => {
  try {
    const category = await Category.findOne({ slug: String(req.params.slug).toLowerCase() });
    if (!category) return sendError(res, 404, "Category not found");
    if (req.body.parent !== undefined) {
      if (req.body.parent && (await Category.exists({ parent: category.slug })))
        return sendError(res, 400, "This category has subcategories, so it must stay top-level");
      const p = await checkParent(req.body.parent, category.slug);
      if (p.error) return sendError(res, 400, p.error);
      category.parent = p.parent;
    }
    if (req.body.attributes !== undefined) {
      const attrs = cleanAttributes(req.body.attributes);
      if (attrs.error) return sendError(res, 400, attrs.error);
      category.attributes = attrs.attributes;
    }
    for (const f of ["name", "description", "image"]) if (req.body[f] !== undefined) category[f] = req.body[f] || (f === "name" ? category.name : null);
    if (req.body.order !== undefined) category.order = Number(req.body.order) || 0;
    if (typeof req.body.isActive === "boolean") category.isActive = req.body.isActive;
    await category.save();
    sendSuccess(res, 200, "Category updated", {
      category: category.toClient(),
      productsInCategory: await Product.countDocuments({ category: category.slug, isActive: true }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
