// How dealer quotes become a device's base (best-condition) price. Shared by
// the admin price tools (live, in the DB) and scripts/applyPriceLists.js
// (the JSON seed files), so both always compute the same number.
//
// Preference order:
//   UK-used physical SIM + eSIM  →  UK-used dual-SIM
//   →  UK-used eSIM-only ÷ 0.9 (valuation takes 10% off eSIM-only, so an
//      eSIM-only phone still comes out at its quoted price)
//   →  brand-new quotes (basis "new" — only when nothing used exists)
// Quotes from several sources are combined by strategy: avg (default), min, max.

const MIN_RATIO = 0.78; // baseMin / baseMax — matches the original tables
const ESIM_FACTOR = 0.9;

const round5k = (n) => Math.round(n / 5000) * 5000;

const combine = (prices, strategy) =>
  strategy === "min"
    ? Math.min(...prices)
    : strategy === "max"
    ? Math.max(...prices)
    : prices.reduce((s, p) => s + p, 0) / prices.length;

const basePriceFor = (quotes, strategy = "avg") => {
  const used = quotes.filter((q) => q.condition === "uk-used");
  const pick = (sim) => used.filter((q) => q.sim === sim).map((q) => q.price);

  const tiers = [
    ["phys+esim", pick("phys+esim"), 1],
    ["dual-sim", pick("dual-sim"), 1],
    ["esim", pick("esim"), 1 / ESIM_FACTOR],
    ["new", quotes.filter((q) => q.condition === "new").map((q) => q.price), 1],
  ];
  for (const [basis, prices, factor] of tiers) {
    if (prices.length) return { basis, price: round5k(combine(prices, strategy) * factor) };
  }
  return null;
};

const baseMinFor = (baseMax) => round5k(baseMax * MIN_RATIO);

// /buy catalog product → the valuation device its UK-used price follows
const CATALOG_MAP = {
  "iphone-17-pro-max": "iphone-17-pro-max-256",
  "iphone-16-pro-max": "iphone-16-pro-max-256",
  "iphone-16-pro": "iphone-16-pro-128",
  "iphone-16-plus": "iphone-16-plus-128",
  "iphone-16": "iphone-16-128",
  "iphone-15-pro-max": "iphone-15-pro-max-256",
  "iphone-15-pro": "iphone-15-pro-128",
  "iphone-15": "iphone-15-128",
  "iphone-14-pro-max": "iphone-14-pro-max-128",
  "iphone-14": "iphone-14-128",
  "iphone-13": "iphone-13-128",
  "iphone-12": "iphone-12-64",
  "iphone-11": "iphone-11-64",
  "samsung-s24-ultra": "s24-ultra-256",
  "samsung-s24": "s24-128",
  "samsung-s23-ultra": "s23-ultra-256",
  "samsung-fold-6": "z-fold-6-256",
  "samsung-flip-6": "z-flip-6-256",
  "pixel-9-pro-xl": "pixel-9-pro-xl-128",
  "pixel-9": "pixel-9-128",
};

module.exports = {
  MIN_RATIO,
  ESIM_FACTOR,
  round5k,
  basePriceFor,
  baseMinFor,
  CATALOG_MAP,
};
