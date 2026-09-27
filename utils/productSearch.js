// Turns a plain-language shopping request into catalog filters and runs it.
// parseQueryRules() is the free path; the AI path (routes/products.js)
// produces the same filter shape, and both go through findProducts().
const Product = require("../models/Product");
const { parseBudget, parseStorage, escapeRegex } = require("./textParsing");

const PHONE_WORDS = /\b(phone|phones|smartphone|iphone|android|samsung|galaxy|pixel|tecno|infinix|xiaomi|redmi|oneplus|mobile)\b/i;

// Gadget category keywords (catalog `category` values for gadgets)
const CATEGORY_WORDS = {
  camera: /\b(camera|cameras|dslr|mirrorless|gopro|vlog\w*|photograph\w*)\b/i,
  watch: /\b(watch|watches|smartwatch|fitness tracker)\b/i,
  stylus: /\b(stylus|pencil|pen)\b/i,
  keyboard: /\b(keyboard|keyboards)\b/i,
  audio: /\b(headphone\w*|earbud\w*|airpods|earphone\w*|speaker\w*|audio|sound)\b/i,
  tablet: /\b(tablet|tablets|ipad\w*)\b/i,
  accessory: /\b(charger|cable|case|adapter|accessor\w*)\b/i,
  security: /\b(cctv|security camera\w*|surveillance|doorbell|home security)\b/i,
  drone: /\b(drone\w*|gimbal\w*)\b/i,
  power: /\b(power bank|powerbank|solar|inverter|power station|generator|nepa|light)\b/i,
  router: /\b(router\w*|wifi|wi-fi)\b/i,
  mifi: /\b(mifi|hotspot|modem)\b/i,
  laptop: /\b(laptop\w*|macbook\w*|notebook|computer|pc)\b/i,
  console: /\b(console\w*|playstation|ps5|ps4|xbox|nintendo|gaming)\b/i,
};
const TIER_WORDS = {
  flagship: /\b(flagship|best|top|premium|pro max|ultra)\b/i,
  budget: /\b(cheap|cheapest|budget|affordable|low cost)\b/i,
};

const STOPWORDS = new Set(
  "a an the i im i'm me my we our you your for to of in on at with and or but is are be need want looking look get buy show find good great nice best that this some any which one ones under below less than over above from between budget naira price around about like please can could would should do does have has it its new used uk brand phone phones gadget gadgets device devices storage gb tb k m n".split(" ")
);

let brandCache = { brands: [], at: 0 };
const knownBrands = async () => {
  if (Date.now() - brandCache.at < 10 * 60 * 1000) return brandCache.brands;
  const brands = await Product.distinct("brand", { isActive: true });
  brandCache = { brands, at: Date.now() };
  return brands;
};

/** Free, rule-based filters from a request like "iphone under 600k 256gb". */
const parseQueryRules = async (q) => {
  const text = String(q || "").slice(0, 300);
  const lower = text.toLowerCase();
  const filters = { ...parseBudget(text) };

  // "phone charger" is an accessory; "phone with a good camera" is a phone
  // (camera is a feature there, not a category)
  if (CATEGORY_WORDS.accessory.test(text)) {
    filters.type = "gadget";
    filters.category = "accessory";
  } else if (PHONE_WORDS.test(text)) {
    filters.type = "phone";
  } else {
    for (const [cat, re] of Object.entries(CATEGORY_WORDS))
      if (re.test(text)) {
        filters.type = "gadget";
        filters.category = cat;
        break;
      }
  }
  if (filters.type === "phone")
    for (const [tier, re] of Object.entries(TIER_WORDS)) if (re.test(text)) filters.category = tier;

  const brands = await knownBrands();
  const brand = brands.find((b) => new RegExp(`\\b${escapeRegex(b.toLowerCase())}\\b`).test(lower))
    || (/\biphone\b/.test(lower) ? brands.find((b) => b.toLowerCase() === "apple") : null)
    || (/\bgalaxy\b/.test(lower) ? brands.find((b) => b.toLowerCase() === "samsung") : null);
  if (brand) filters.brand = brand;

  const storage = parseStorage(text);
  if (storage) filters.storage = storage;
  if (/\bbrand[- ]?new\b|\bnew\b/.test(lower) && !/\bused\b/.test(lower)) filters.condition = "brand-new";
  else if (/\b(uk[- ]?used|used|fairly used)\b/.test(lower)) filters.condition = "uk-used";
  if (/cheap|lowest|budget/.test(lower)) filters.sort = "price-asc";

  // Leftover meaningful words, e.g. "17 pro max" or "wedding"
  const matchedCategoryWord = filters.category ? CATEGORY_WORDS[filters.category] : null;
  const GENERIC = new Set(["phone", "phones", "smartphone", "mobile", "android"]);
  // Feature wishes ("good camera", "long battery") can't be matched against
  // product names, so they don't become name keywords
  const FEATURES = new Set(["camera", "cameras", "battery", "photos", "photo", "pictures", "selfie", "selfies", "video", "videos", "gaming", "games", "fast", "big", "small", "long", "lasting", "life", "screen", "display", "strong", "durable", "lightweight", "light", "portable", "quality", "cheap", "affordable", "premium", "flagship", "latest", "school", "work", "business", "student", "mum", "dad", "wife", "husband", "gift", "house", "home", "office"]);
  filters.keywords = lower
    .replace(/[₦,]/g, " ")
    .split(/[^a-z0-9+]+/)
    .filter((w) => w && !STOPWORDS.has(w) && !GENERIC.has(w) && !FEATURES.has(w))
    .filter((w) => !/^\d+(\.\d+)?(k|m|gb|tb)$/.test(w) && !/^\d{3,}$/.test(w)) // prices, storage
    .filter((w) => !(brand && w === brand.toLowerCase()))
    .filter((w) => !(matchedCategoryWord && matchedCategoryWord.test(w)))
    .slice(0, 6);

  return filters;
};

/**
 * Run filters against the catalog. If keywords make it come back empty,
 * retries without them (`relaxed: true`) so the shopper still sees options.
 */
const findProducts = async (filters, { limit = 24 } = {}) => {
  const priceField = filters.condition === "brand-new" ? "priceBrandNew" : "priceUkUsed";
  const base = { isActive: true };
  if (filters.type === "phone" || filters.type === "gadget") base.type = filters.type;
  if (filters.category) base.category = filters.category;
  if (filters.brand) base.brand = new RegExp(`^${escapeRegex(filters.brand)}$`, "i");
  if (filters.storage) base.storage = filters.storage;
  if (filters.minPrice || filters.maxPrice) {
    base[priceField] = {};
    if (filters.minPrice) base[priceField].$gte = filters.minPrice;
    if (filters.maxPrice) base[priceField].$lte = filters.maxPrice;
  }
  const withKeywords = { ...base };
  if (filters.keywords?.length)
    withKeywords.$and = filters.keywords.map((k) => {
      const rx = new RegExp(escapeRegex(k), "i");
      return { $or: [{ name: rx }, { tags: rx }, { spec: rx }] };
    });

  // With a budget, show the best you can afford first
  const sort =
    filters.sort === "price-asc"
      ? { [priceField]: 1 }
      : filters.sort === "price-desc" || filters.maxPrice
      ? { [priceField]: -1 }
      : { type: 1, createdAt: 1 };

  let products = await Product.find(withKeywords).sort(sort).limit(limit);
  let relaxed = false;
  if (!products.length && filters.keywords?.length) {
    products = await Product.find(base).sort(sort).limit(limit);
    relaxed = true;
  }
  return { products, relaxed };
};

/** One-line description of the filters, for replies. */
const describeFilters = (f) => {
  const parts = [];
  if (f.condition === "brand-new") parts.push("brand-new");
  if (f.brand) parts.push(f.brand);
  if (f.category) parts.push(f.category);
  if (!f.category && f.type) parts.push(f.type === "phone" ? "phones" : "gadgets");
  if (f.storage) parts.push(f.storage);
  if (f.maxPrice) parts.push(`under ₦${f.maxPrice.toLocaleString()}`);
  if (f.minPrice) parts.push(`from ₦${f.minPrice.toLocaleString()}`);
  return parts.join(" ") || "everything";
};

module.exports = { parseQueryRules, findProducts, describeFilters, knownBrands, CATEGORY_WORDS };
