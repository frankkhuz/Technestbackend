const express = require("express");
const Product = require("../models/Product");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { parseQueryRules, findProducts, describeFilters, knownBrands, CATEGORY_WORDS } = require("../utils/productSearch");
const aiSoftLimit = require("../utils/aiSoftLimit");
const ai = require("../utils/ai");
const router = express.Router();

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Resolve by slug first (what the frontend cart uses), then by _id
const findProduct = (idOrSlug) => {
  const query = [{ slug: String(idOrSlug).toLowerCase() }];
  if (/^[a-f0-9]{24}$/i.test(idOrSlug)) query.push({ _id: idOrSlug });
  return Product.findOne({ $or: query });
};

/**
 * @swagger
 * /api/products:
 *   get:
 *     summary: Browse the buy catalog (phones and gadgets)
 *     tags: [Products]
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [phone, gadget] }
 *       - in: query
 *         name: category
 *         description: Phone tier (flagship, mid-range, budget) or gadget category (camera, watch, ...)
 *         schema: { type: string }
 *       - in: query
 *         name: brand
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         description: Search name / brand
 *         schema: { type: string }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [default, price-asc, price-desc] }
 *       - in: query
 *         name: condition
 *         description: Which price to sort by
 *         schema: { type: string, enum: [uk-used, brand-new], default: uk-used }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100, maximum: 200 }
 *     responses:
 *       200:
 *         description: Products fetched
 */
router.get("/", async (req, res, next) => {
  try {
    const { type, category, brand, q, sort, condition } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 100));

    const filter = { isActive: true };
    if (type === "phone" || type === "gadget") filter.type = type;
    if (typeof category === "string" && category) filter.category = category;
    if (typeof brand === "string" && brand && brand !== "all")
      filter.brand = new RegExp(`^${escapeRegex(brand)}$`, "i");
    if (typeof q === "string" && q.trim()) {
      const rx = new RegExp(escapeRegex(q.trim().slice(0, 100)), "i");
      filter.$or = [{ name: rx }, { brand: rx }, { tags: rx }];
    }

    const priceField = condition === "brand-new" ? "priceBrandNew" : "priceUkUsed";
    const sortSpec =
      sort === "price-asc"
        ? { [priceField]: 1 }
        : sort === "price-desc"
        ? { [priceField]: -1 }
        : { type: 1, createdAt: 1 };

    const [products, total] = await Promise.all([
      Product.find(filter)
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
    ]);

    sendSuccess(res, 200, "Products fetched", {
      products: products.map((p) => p.toClient()),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
});

// AI filter results are cached per query so repeat searches cost nothing
const aiFilterCache = new Map();
const AI_CACHE_MS = 60 * 60 * 1000;

const FILTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["phone", "gadget", ""] },
    category: { type: "string", description: "Phone tier (flagship, mid-range, budget) or gadget category, or \"\"" },
    brand: { type: "string", description: "Exact brand from the list, or \"\"" },
    minPrice: { type: "integer", description: "Naira, 0 if none" },
    maxPrice: { type: "integer", description: "Naira, 0 if none" },
    condition: { type: "string", enum: ["uk-used", "brand-new", ""] },
    storage: { type: "string", description: "e.g. 256GB, or \"\"" },
    keywords: { type: "array", items: { type: "string" }, description: "Model words to match in product names, e.g. [\"17\", \"pro\"]" },
    sort: { type: "string", enum: ["default", "price-asc", "price-desc"] },
  },
  required: ["type", "category", "brand", "minPrice", "maxPrice", "condition", "storage", "keywords", "sort"],
};

const aiFilters = async (q) => {
  const key = q.toLowerCase().replace(/\s+/g, " ").trim();
  const hit = aiFilterCache.get(key);
  if (hit && Date.now() - hit.at < AI_CACHE_MS) return { ok: true, data: hit.filters };

  const brands = await knownBrands();
  const result = await ai.run({
    feature: "product_search",
    system: `Turn a shopper's request on TechNest (a Nigerian gadget store, prices in naira) into catalog search filters.
Brands in the catalog: ${JSON.stringify(brands)}.
Phone tiers (category when type is phone): flagship, mid-range, budget.
Gadget categories (category when type is gadget): ${JSON.stringify(Object.keys(CATEGORY_WORDS))}.
"600k" = 600000, "1.2m" = 1200000. Use "" / 0 / [] for anything the request doesn't say. keywords are only model words that must appear in the product name (e.g. "17 pro max" → ["17","pro","max"]); don't put brands, categories or prices in keywords.`,
    messages: [{ role: "user", content: q }],
    schema: FILTER_SCHEMA,
    effort: "low",
    maxTokens: 4000,
  });
  if (!result.ok) return result;

  const f = result.data;
  const filters = {
    type: f.type || undefined,
    category: f.category || undefined,
    brand: brands.includes(f.brand) ? f.brand : undefined,
    minPrice: f.minPrice > 0 ? f.minPrice : undefined,
    maxPrice: f.maxPrice > 0 ? f.maxPrice : undefined,
    condition: f.condition || undefined,
    storage: f.storage || undefined,
    keywords: f.keywords.slice(0, 6),
    sort: f.sort === "default" ? undefined : f.sort,
  };
  if (aiFilterCache.size > 500) aiFilterCache.delete(aiFilterCache.keys().next().value);
  aiFilterCache.set(key, { filters, at: Date.now() });
  return { ok: true, data: filters };
};

/**
 * @swagger
 * /api/products/search:
 *   get:
 *     summary: Plain-language catalog search ("iphone under 600k with 256gb")
 *     description: >
 *       Works without AI: a built-in reader picks out budget, brand, category,
 *       storage and condition. With AI available it understands any phrasing.
 *       `filters` shows how the request was read (display it as removable
 *       chips); `relaxed: true` means nothing matched every word, so model
 *       keywords were dropped. Call it when the shopper submits, not on
 *       every keystroke. `ai=0` forces the free reader.
 *     tags: [Products]
 *     security: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: ai
 *         schema: { type: string, enum: ["0", "1"], default: "1" }
 *     responses:
 *       200:
 *         description: data.products, data.filters, data.summary, data.source (ai | rules), data.relaxed
 */
router.get("/search", aiSoftLimit, async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 300) : "";
    if (!q) return sendError(res, 400, "Type what you're looking for in `q`");

    let filters;
    let source = "rules";
    let aiReason;
    if (req.query.ai !== "0" && req.aiAllowed) {
      const result = await aiFilters(q);
      if (result.ok) {
        filters = result.data;
        source = "ai";
      } else aiReason = result.reason;
    } else if (req.query.ai !== "0") aiReason = "rate_limited";
    if (!filters) filters = await parseQueryRules(q);

    const { products, relaxed } = await findProducts(filters);
    sendSuccess(res, 200, "Search results", {
      products: products.map((p) => p.toClient()),
      filters,
      summary: describeFilters(filters),
      relaxed,
      source,
      aiReason,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/products/{id}:
 *   get:
 *     summary: Get one catalog product by slug (e.g. iphone-17-pro-max) or _id
 *     tags: [Products]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Product fetched
 *       404:
 *         description: Product not found
 */
router.get("/:id", async (req, res, next) => {
  try {
    const product = await findProduct(req.params.id);
    if (!product || !product.isActive)
      return sendError(res, 404, "Product not found");
    sendSuccess(res, 200, "Product fetched", { product: product.toClient() });
  } catch (err) {
    next(err);
  }
});

// ─── Admin catalog management ────────────────────────────────────────────────

const EDITABLE_FIELDS = [
  "type",
  "name",
  "brand",
  "category",
  "image",
  "storage",
  "colors",
  "ram",
  "spec",
  "badge",
  "tags",
  "priceUkUsed",
  "priceBrandNew",
  "inStock",
  "isActive",
];

const pickEditable = (body) => {
  const out = {};
  for (const f of EDITABLE_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  // Accept the frontend's field names too
  if (body.gadgetCategory !== undefined && out.category === undefined)
    out.category = body.gadgetCategory;
  if (body.color !== undefined && out.colors === undefined) out.colors = body.color;
  return out;
};

/**
 * @swagger
 * /api/products:
 *   post:
 *     summary: Add a catalog product (admin)
 *     tags: [Products]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slug, type, name, brand, category, priceUkUsed, priceBrandNew]
 *             properties:
 *               slug: { type: string, example: iphone-17-pro-max }
 *               type: { type: string, enum: [phone, gadget] }
 *               name: { type: string }
 *               brand: { type: string }
 *               category: { type: string }
 *               image: { type: string }
 *               storage: { type: array, items: { type: string } }
 *               colors: { type: array, items: { type: string } }
 *               ram: { type: string }
 *               spec: { type: string }
 *               badge: { type: string }
 *               tags: { type: array, items: { type: string } }
 *               priceUkUsed: { type: number }
 *               priceBrandNew: { type: number }
 *               inStock: { type: boolean }
 *     responses:
 *       201:
 *         description: Product created
 *       409:
 *         description: Slug already in use
 */
router.post(
  "/",
  protect,
  restrictTo("admin"),
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const fields = pickEditable(req.body);
      const slug = req.body.slug || req.body.id;
      if (
        !slug ||
        !fields.type ||
        !fields.name ||
        !fields.brand ||
        !fields.category ||
        fields.priceUkUsed === undefined ||
        fields.priceBrandNew === undefined
      )
        return sendError(
          res,
          400,
          "slug, type, name, brand, category, priceUkUsed and priceBrandNew are required"
        );

      if (await Product.exists({ slug: String(slug).toLowerCase() }))
        return sendError(res, 409, "A product with that slug already exists");

      const product = await Product.create({ ...fields, slug });
      sendSuccess(res, 201, "Product created", { product: product.toClient() });
    } catch (err) {
      if (err.name === "ValidationError") return sendError(res, 400, err.message);
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/products/{id}:
 *   patch:
 *     summary: Update a catalog product — price, stock, details (admin)
 *     tags: [Products]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Product updated
 *       404:
 *         description: Product not found
 */
router.patch(
  "/:id",
  protect,
  restrictTo("admin"),
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const product = await findProduct(req.params.id);
      if (!product) return sendError(res, 404, "Product not found");

      Object.assign(product, pickEditable(req.body));
      await product.save();
      sendSuccess(res, 200, "Product updated", { product: product.toClient() });
    } catch (err) {
      if (err.name === "ValidationError") return sendError(res, 400, err.message);
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/products/{id}:
 *   delete:
 *     summary: Remove a product from the catalog (admin, soft delete)
 *     tags: [Products]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Product removed
 */
router.delete(
  "/:id",
  protect,
  restrictTo("admin"),
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      const product = await findProduct(req.params.id);
      if (!product) return sendError(res, 404, "Product not found");

      // Soft delete so past orders and "buy again" can still resolve it
      product.isActive = false;
      await product.save();
      sendSuccess(res, 200, "Product removed", { id: product.slug });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
