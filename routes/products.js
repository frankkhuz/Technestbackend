const express = require("express");
const Product = require("../models/Product");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { parseQueryRules, findProducts, describeFilters, knownBrands, CATEGORY_WORDS } = require("../utils/productSearch");
const aiSoftLimit = require("../utils/aiSoftLimit");
const Category = require("../models/Category");
const { expandCategory, validateAttributes, attributeFilter } = require("../utils/categories");
const { parseCsvWithHeader, splitList, parseBool } = require("../utils/csv");
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
 *         description: "Category slug from GET /api/categories. A group (e.g. audio, gaming) includes its subcategories"
 *         schema: { type: string }
 *       - in: query
 *         name: a.<key>
 *         description: "Category filters, from GET /api/categories/{slug} → filters.attributes[].param — e.g. a.connectivity=Wireless, a.type=Over-ear,On-ear (any of), a.noiseCancelling=true, a.capacity_min=10000"
 *         schema: { type: string }
 *       - in: query
 *         name: minPrice
 *         schema: { type: number }
 *       - in: query
 *         name: maxPrice
 *         schema: { type: number }
 *       - in: query
 *         name: onSale
 *         description: "true = only products in a live flash sale"
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
    if (typeof category === "string" && category) {
      // A group (e.g. "audio") includes its children; a.<key> filters use
      // the category's own attributes (see GET /api/categories/{slug})
      const cat = await Category.findOne({ slug: category.toLowerCase() });
      filter.category = cat ? { $in: await expandCategory(cat.slug) } : category;
      if (cat) Object.assign(filter, attributeFilter(cat, req.query));
    }
    const priceField = condition === "brand-new" ? "priceBrandNew" : "priceUkUsed";
    const minPrice = Number(req.query.minPrice);
    const maxPrice = Number(req.query.maxPrice);
    if (minPrice > 0 || maxPrice > 0)
      filter[priceField] = { ...(minPrice > 0 ? { $gte: minPrice } : {}), ...(maxPrice > 0 ? { $lte: maxPrice } : {}) };
    if (req.query.onSale === "true") {
      const now = new Date();
      Object.assign(filter, { "sale.startsAt": { $lte: now }, "sale.endsAt": { $gt: now } });
    }
    if (typeof brand === "string" && brand && brand !== "all")
      filter.brand = new RegExp(`^${escapeRegex(brand)}$`, "i");
    if (typeof q === "string" && q.trim()) {
      const rx = new RegExp(escapeRegex(q.trim().slice(0, 100)), "i");
      filter.$or = [{ name: rx }, { brand: rx }, { tags: rx }];
    }

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
/**
 * @swagger
 * /api/products/flash-sale:
 *   get:
 *     summary: Products in a live flash sale, ending soonest first
 *     description: "Each product has sale: { active, priceUkUsed, priceBrandNew, endsAt, label }. Use data.serverTime for the countdown so it doesn't depend on the phone's clock. data.upcoming lists sales starting in the next 7 days."
 *     tags: [Products]
 *     security: []
 *     responses:
 *       200:
 *         description: "data: { products, upcoming, serverTime }"
 */
router.get("/flash-sale", async (req, res, next) => {
  try {
    const now = new Date();
    const [live, upcoming] = await Promise.all([
      Product.find({ isActive: true, "sale.startsAt": { $lte: now }, "sale.endsAt": { $gt: now } }).sort({ "sale.endsAt": 1 }).limit(100),
      Product.find({ isActive: true, "sale.startsAt": { $gt: now, $lte: new Date(now.getTime() + 7 * 864e5) } }).sort({ "sale.startsAt": 1 }).limit(50),
    ]);
    sendSuccess(res, 200, "Flash sale fetched", {
      products: live.filter((p) => p.saleActive(now)).map((p) => p.toClient()),
      upcoming: upcoming.map((p) => p.toClient()),
      serverTime: now.toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

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
  "stockQuantity",
  "isActive",
  "attributes",
  "sale",
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
 * Checks a sale against the product's normal prices.
 * @returns {{ sale }} normalized (null = no sale) or {{ error }}
 */
const validateSale = (sale, { priceUkUsed, priceBrandNew }) => {
  if (sale === null) return { sale: null };
  if (typeof sale !== "object") return { error: "sale must be an object or null" };
  const startsAt = sale.startsAt ? new Date(sale.startsAt) : new Date();
  const endsAt = new Date(sale.endsAt);
  if (isNaN(startsAt) || isNaN(endsAt)) return { error: "Sale needs a valid endsAt (and optional startsAt) date" };
  if (endsAt <= startsAt) return { error: "The sale must end after it starts" };
  const price = (v) => (v === undefined || v === null || v === "" ? null : Math.round(Number(v)));
  const uk = price(sale.priceUkUsed);
  const bn = price(sale.priceBrandNew);
  if (!uk && !bn) return { error: "Give a sale price for UK used and/or brand new" };
  if ((uk !== null && !(uk > 0 && uk < priceUkUsed)) || (bn !== null && !(bn > 0 && bn < priceBrandNew)))
    return { error: "Sale prices must be above 0 and below the normal price" };
  return { sale: { priceUkUsed: uk, priceBrandNew: bn, startsAt, endsAt, label: String(sale.label || "Flash Sale").slice(0, 30) } };
};

// Category must exist, attributes must fit it, and a sale must undercut the
// normal price. Mutates and returns fields, or returns { error }.
const checkProductFields = async (fields, current = null) => {
  if (fields.stockQuantity !== undefined && fields.stockQuantity !== null) {
    const n = Number(fields.stockQuantity);
    if (!Number.isInteger(n) || n < 0) return { error: "stockQuantity must be a whole number (or null to stop counting)" };
    fields.stockQuantity = n;
  }
  const categorySlug = String(fields.category ?? current?.category ?? "").toLowerCase();
  const category = await Category.findOne({ slug: categorySlug });
  if (!category) return { error: `Unknown category "${categorySlug}". See GET /api/categories.` };
  if (fields.category !== undefined) fields.category = category.slug;
  if (fields.attributes !== undefined || (fields.category !== undefined && fields.category !== current?.category)) {
    const checked = validateAttributes(category, fields.attributes ?? current?.attributes ?? {});
    if (checked.error) return { error: checked.error };
    fields.attributes = checked.attributes;
  }
  if (fields.sale !== undefined) {
    const checked = validateSale(fields.sale, {
      priceUkUsed: fields.priceUkUsed ?? current?.priceUkUsed,
      priceBrandNew: fields.priceBrandNew ?? current?.priceBrandNew,
    });
    if (checked.error) return { error: checked.error };
    fields.sale = checked.sale;
  }
  return { fields };
};

const slugify = (s) =>
  String(s || "").toLowerCase().replace(/\+/g, " plus ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);

const PRODUCT_COLUMNS = new Set(["slug", "type", "name", "brand", "category", "priceukused", "pricebrandnew", "storage", "colors", "ram", "spec", "badge", "tags", "image", "instock", "stock"]);

/**
 * @swagger
 * /api/products/bulk:
 *   post:
 *     summary: Admin — add or update many products from a CSV
 *     description: >
 *       Header row required. Columns: slug (optional — made from the name),
 *       type (phone | gadget), name, brand, category (slug),
 *       priceUkUsed, priceBrandNew, storage / colors / tags (separate values
 *       with |), ram, spec, badge, image, inStock (yes/no), stock (units on
 *       hand — leave blank not to count). Any other column
 *       is read as a filter for that row's category, e.g. connectivity,
 *       noiseCancelling. Rows whose slug exists are updated (blank cells are
 *       left alone). Send `dryRun: true` first to see what would happen.
 *       Up to 1,000 rows (2 MB) per upload.
 *     tags: [Products]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [csv]
 *             properties:
 *               csv: { type: string }
 *               dryRun: { type: boolean }
 *     responses:
 *       200:
 *         description: "data: { created, updated, failed, dryRun, rows: [{ line, slug, action: create | update | error, error? }] }"
 */
router.post("/bulk", protect, restrictTo("admin"), verifyCsrfToken, async (req, res, next) => {
  try {
    const { rows } = parseCsvWithHeader(req.body.csv);
    if (!rows.length) return sendError(res, 400, "The CSV needs a header row and at least one product.");
    if (rows.length > 1000) return sendError(res, 400, "Upload at most 1,000 rows at a time.");
    const dryRun = req.body.dryRun === true;

    const categories = new Map((await Category.find()).map((c) => [c.slug, c]));
    const slugs = rows.map((r) => slugify(r.values.slug || r.values.name));
    const existing = new Map((await Product.find({ slug: { $in: slugs } })).map((p) => [p.slug, p]));
    const results = [];
    const ops = [];

    for (const [i, { line, values: v }] of rows.entries()) {
      const slug = slugs[i];
      const fail = (error) => results.push({ line, slug: slug || undefined, action: "error", error });
      if (!slug) { fail("Needs a name or slug"); continue; }
      if (results.some((r) => r.slug === slug && r.action !== "error")) { fail("This slug appears twice in the file"); continue; }
      const current = existing.get(slug);

      const fields = {};
      const text = (k, f = k) => { if (v[k]) fields[f] = v[k]; };
      text("type"); text("name"); text("brand"); text("ram"); text("spec"); text("badge"); text("image");
      if (v.category) fields.category = v.category.toLowerCase();
      for (const [col, f] of [["priceukused", "priceUkUsed"], ["pricebrandnew", "priceBrandNew"]])
        if (v[col]) fields[f] = Number(String(v[col]).replace(/[₦,\s]/g, ""));
      for (const [col, f] of [["storage", "storage"], ["colors", "colors"], ["tags", "tags"]]) if (v[col]) fields[f] = splitList(v[col]);
      if (v.instock) fields.inStock = parseBool(v.instock);
      // bulkWrite skips the model's save hook, so keep inStock in step here
      if (v.stock !== undefined && v.stock !== "") {
        const n = Number(v.stock);
        if (!Number.isInteger(n) || n < 0) { fail("stock must be a whole number"); continue; }
        Object.assign(fields, { stockQuantity: n, inStock: n > 0 });
      }

      const merged = { ...(current ? current.toObject() : {}), ...fields };
      if (!current && (!merged.type || !merged.name || !merged.brand || !merged.category || !(merged.priceUkUsed >= 0) || !(merged.priceBrandNew >= 0))) {
        fail("New products need type, name, brand, category, priceUkUsed and priceBrandNew"); continue;
      }
      if (!["phone", "gadget"].includes(merged.type)) { fail('type must be "phone" or "gadget"'); continue; }
      if ([merged.priceUkUsed, merged.priceBrandNew].some((n) => !Number.isFinite(n) || n < 0)) { fail("Prices must be numbers"); continue; }
      const category = categories.get(merged.category);
      if (!category) { fail(`Unknown category "${merged.category}"`); continue; }

      // Extra columns are this category's filters (header names are lower-cased)
      const byLower = new Map(category.attributes.map((a) => [a.key.toLowerCase(), a.key]));
      const attrInput = {};
      let unknown = null;
      for (const [col, val] of Object.entries(v)) {
        if (PRODUCT_COLUMNS.has(col) || val === "") continue;
        if (!byLower.has(col)) { unknown = col; break; }
        attrInput[byLower.get(col)] = val;
      }
      if (unknown) { fail(`"${unknown}" isn't a column or a filter for ${category.name}`); continue; }
      if (Object.keys(attrInput).length || fields.category) {
        const checked = validateAttributes(category, { ...(fields.category && fields.category !== current?.category ? {} : current?.attributes || {}), ...attrInput });
        if (checked.error) { fail(checked.error); continue; }
        fields.attributes = checked.attributes;
      }

      results.push({ line, slug, action: current ? "update" : "create" });
      ops.push(current
        ? { updateOne: { filter: { slug }, update: { $set: fields } } }
        : { insertOne: { document: { inStock: true, isActive: true, storage: [], colors: [], tags: [], attributes: {}, ...fields, slug } } });
    }

    if (!dryRun && ops.length) await Product.bulkWrite(ops, { ordered: false });
    const count = (a) => results.filter((r) => r.action === a).length;
    sendSuccess(res, 200, dryRun ? "Preview — nothing saved" : "Products uploaded", {
      created: count("create"),
      updated: count("update"),
      failed: count("error"),
      dryRun,
      rows: results,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/products/flash-sale:
 *   post:
 *     summary: Admin — put several products on flash sale at once
 *     description: Give `percentOff` (prices rounded to the nearest ₦100) or exact prices per product via PATCH /api/products/{id} { sale }.
 *     tags: [Products]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [slugs, percentOff, endsAt]
 *             properties:
 *               slugs: { type: array, items: { type: string } }
 *               percentOff: { type: number, example: 15 }
 *               startsAt: { type: string, format: date-time, description: "Default: now" }
 *               endsAt: { type: string, format: date-time }
 *               label: { type: string, example: Flash Sale }
 *     responses:
 *       200:
 *         description: "data: { updated, notFound }"
 *   delete:
 *     summary: Admin — end the flash sale on these products now
 *     tags: [Products]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               slugs: { type: array, items: { type: string }, description: "Omit to end every sale" }
 *     responses:
 *       200:
 *         description: data.ended
 */
router.post("/flash-sale", protect, restrictTo("admin"), verifyCsrfToken, async (req, res, next) => {
  try {
    const slugs = (Array.isArray(req.body.slugs) ? req.body.slugs : []).map((s) => String(s).toLowerCase());
    const pct = Number(req.body.percentOff);
    if (!slugs.length) return sendError(res, 400, "Choose at least one product.");
    if (!(pct > 0 && pct < 90)) return sendError(res, 400, "percentOff must be between 1 and 89.");
    const products = await Product.find({ slug: { $in: slugs } });
    const round = (n) => Math.max(100, Math.round(n / 100) * 100);
    for (const p of products) {
      const checked = validateSale(
        { priceUkUsed: round(p.priceUkUsed * (1 - pct / 100)), priceBrandNew: round(p.priceBrandNew * (1 - pct / 100)), startsAt: req.body.startsAt, endsAt: req.body.endsAt, label: req.body.label },
        p
      );
      if (checked.error) return sendError(res, 400, `${p.name}: ${checked.error}`);
      p.sale = checked.sale;
    }
    await Promise.all(products.map((p) => p.save()));
    const found = new Set(products.map((p) => p.slug));
    sendSuccess(res, 200, "Flash sale set", { updated: products.length, notFound: slugs.filter((s) => !found.has(s)) });
  } catch (err) {
    next(err);
  }
});

router.delete("/flash-sale", protect, restrictTo("admin"), verifyCsrfToken, async (req, res, next) => {
  try {
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs.map((s) => String(s).toLowerCase()) : null;
    const result = await Product.updateMany(slugs ? { slug: { $in: slugs } } : { sale: { $ne: null } }, { sale: null });
    sendSuccess(res, 200, "Flash sale ended", { ended: result.modifiedCount });
  } catch (err) {
    next(err);
  }
});

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
 *               stockQuantity: { type: integer, nullable: true, description: "Units on hand; null = not counted. When set, inStock follows it and sales reduce it." }
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
      const checked = await checkProductFields(fields);
      if (checked.error) return sendError(res, 400, checked.error);

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

      const fields = pickEditable(req.body);
      const checked = await checkProductFields(fields, product);
      if (checked.error) return sendError(res, 400, checked.error);
      Object.assign(product, fields);
      product.markModified("attributes");
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
