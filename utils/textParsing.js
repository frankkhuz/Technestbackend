// Small free-text helpers shared by the no-AI ("rules") paths: price lists,
// search queries, budgets, device names.

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "185k" → 185000, "N1.650M" → 1650000, "1,120,000" → 1120000,
// "₦200,000" → 200000, "=1.090" (millions shorthand) → 1090000, "1M" → 1000000
const PRICE_RE =
  /(?:₦|\bN|=|-|\s|^)\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|million)?(?![\w])/gi;

const parseAmount = (num, suffix) => {
  const raw = num.replace(/,/g, "");
  let n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const s = (suffix || "").toLowerCase();
  if (s === "k") n *= 1000;
  else if (s === "m" || s === "million") n *= 1_000_000;
  else if (num.includes(",")) {
    // plain thousands-separated amount
  } else if (/^\d\.\d{2,3}$/.test(raw)) n *= 1_000_000; // "1.090" = ₦1.09M
  else if (n < 1000) return null; // a bare small number is not a price
  return Math.round(n);
};

/** All plausible naira amounts in a string (₦5,000 – ₦50,000,000). */
const findPrices = (text) => {
  const out = [];
  for (const m of text.matchAll(PRICE_RE)) {
    // Skip storage like "256GB" / "1TB" — the regex stops before letters,
    // so check what follows the number
    const after = text.slice(m.index + m[0].length).trimStart().toLowerCase();
    if (!m[2] && /^(gb|tb|mb)\b/.test(after)) continue;
    const n = parseAmount(m[1], m[2]);
    if (n && n >= 5000 && n <= 50_000_000) out.push(n);
  }
  return out;
};

/** "under 600k" / "below ₦1.2m" / "600k budget" / "between 300k and 500k" */
const parseBudget = (text) => {
  const t = text.toLowerCase();
  const amount = (s) => {
    const p = findPrices(" " + s);
    return p.length ? p[0] : null;
  };
  const between = t.match(/between\s+(.+?)\s+(?:and|-|to)\s+(\S+(?:\s*(?:k|m))?)/);
  if (between) {
    const a = amount(between[1]);
    const b = amount(between[2]);
    if (a && b) return { minPrice: Math.min(a, b), maxPrice: Math.max(a, b) };
  }
  const under = t.match(/(?:under|below|less than|max(?:imum)?|not more than|within|up to|budget(?: is| of)?)\s*(?:of\s*)?(₦?\s*n?\d[\d,.]*\s*(?:k|m|million)?)/);
  if (under) {
    const a = amount(under[1]);
    if (a) return { maxPrice: a };
  }
  const over = t.match(/(?:over|above|more than|at least|from)\s*(₦?\s*n?\d[\d,.]*\s*(?:k|m|million)?)/);
  if (over) {
    const a = amount(over[1]);
    if (a) return { minPrice: a };
  }
  const bare = findPrices(" " + t);
  if (bare.length === 1 && /budget|₦|naira|\bk\b|\d\s*k\b|\d\s*m\b/.test(t))
    return { maxPrice: bare[0] };
  return {};
};

const parseStorage = (text) => {
  const m = text.match(/(\d{1,4})\s*(gb|tb)\b/i);
  if (!m) return null;
  return `${Number(m[1])}${m[2].toUpperCase()}`;
};

// Compact comparable form of a device name:
// "Samsung Galaxy S22 Ultra" → "s22ultra", "iPhone 14 Pro Max" → "iphone14promax",
// "Flip5" → "zflip5", "SE 3ed Gen" → "se3rdgen"
const normalizeDeviceName = (name) => {
  let t = ` ${String(name).toLowerCase()} `;
  t = t
    .replace(/\+/g, " plus ")
    .replace(/[()[\].,_*|:/\\-]/g, " ")
    .replace(/\b(samsung|galaxy|google|apple|uk|used|new|5g|4g|lte)\b/g, " ")
    .replace(/ultr(?!a)/g, "ultra")
    .replace(/\b3ed\b/g, "3rd")
    .replace(/\b(\d+)\s*(st|nd|rd|th)\s*gen(eration)?\b/g, "$1$2gen")
    .replace(/\bz\s*(?=flip|fold)/g, "")
    .replace(/(flip|fold)/g, "z$1");
  return t.replace(/\s+/g, "");
};

const STORAGE_TOKEN_RE = /\b\d{1,4}\s*(gb|tb)\b/gi;

module.exports = {
  escapeRegex,
  findPrices,
  parseBudget,
  parseStorage,
  normalizeDeviceName,
  STORAGE_TOKEN_RE,
};
