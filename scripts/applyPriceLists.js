// Turns the market quotes in data/marketPrices.json into:
//   1. data/valuationDevices.json — the base (best-condition) prices the
//      swap/sell valuation engine starts from (iphone + android tables;
//      laptops are left as they are)
//   2. data/catalog.json — UK-used prices for /buy catalog phones that map
//      to a quoted device
//   3. (with --db) the live database: catalog Product UK-used prices, and the
//      ValuationDevice collection (quotes + base prices) the app reads at runtime
//
// Admins can also edit prices from the app (/api/admin/prices). Those edits
// live only in the database — run this with --db only when you mean to push
// the JSON files' quotes over what's there.
//
//   npm run prices:apply -- --dry-run          show what would change
//   npm run prices:apply                       rewrite the JSON files
//   npm run prices:apply -- --db               ...and update Product prices in MONGO_URI
//   options: --strategy=avg|min|max (default avg)  how to combine quotes from several sources
//            --markup=10                           % added on top for catalog selling prices
//
// How a device's base price is chosen, in order of preference:
//   UK-used physical SIM + eSIM quotes  →  UK-used dual-SIM quotes
//   →  UK-used eSIM-only quotes ÷ 0.9 (the valuation takes 10% off eSIM-only,
//      so an eSIM-only phone still comes out at its quoted price)
//   →  brand-new quotes (flagged basis "new" — only when nothing used exists)
require("dotenv").config();
const fs = require("fs");
const path = require("path");

const DATA = path.join(__dirname, "..", "data");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const {
  basePriceFor,
  baseMinFor,
  round5k,
  CATALOG_MAP,
} = require("../utils/marketPricing");

const DRY_RUN = flag("dry-run");
const UPDATE_DB = flag("db");
const STRATEGY = option("strategy", "avg");
const MARKUP = Number(option("markup", 0));

if (!["avg", "min", "max"].includes(STRATEGY)) {
  console.error("--strategy must be avg, min or max");
  process.exit(1);
}

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DATA, file), "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(value, null, 1) + "\n");

const market = readJson("marketPrices.json");
const valuation = readJson("valuationDevices.json");
const catalog = readJson("catalog.json");

// ── 1. Valuation tables ──────────────────────────────────────────────────────
const report = { updated: [], added: [], legacy: [], newBasis: [] };
const tables = { iphone: valuation.iphone, android: valuation.android };
const priced = new Map();

for (const device of market.devices) {
  const base = basePriceFor(device.quotes, STRATEGY);
  if (!base) continue;
  priced.set(device.id, base);

  const table = tables[device.subType];
  const entry = {
    id: device.id,
    name: device.name,
    storage: device.storage,
    baseMin: baseMinFor(base.price),
    baseMax: base.price,
    priceSource: "market",
    basis: base.basis,
  };
  if (base.basis === "new") report.newBasis.push(device.id);

  const i = table.findIndex((d) => d.id === device.id);
  if (i === -1) {
    table.push(entry);
    report.added.push(`${device.id}  ₦${entry.baseMax.toLocaleString()}`);
  } else {
    const old = table[i].baseMax;
    if (old !== entry.baseMax)
      report.updated.push(`${device.id}  ₦${old.toLocaleString()} → ₦${entry.baseMax.toLocaleString()}`);
    table[i] = { ...table[i], ...entry };
  }
}

for (const [key, table] of Object.entries(tables)) {
  for (const d of table) {
    if (d.id.startsWith("other-") || priced.has(d.id)) continue;
    d.priceSource = "legacy";
    report.legacy.push(`${d.id}  ₦${d.baseMax.toLocaleString()}`);
  }
  // Priciest first (roughly newest first), manual-entry option last
  const other = table.filter((d) => d.id.startsWith("other-"));
  const rest = table.filter((d) => !d.id.startsWith("other-"));
  if (key === "android") {
    const brandRank = (d) =>
      d.name.startsWith("Samsung") ? 0 : d.name.startsWith("Google") ? 1 : 2;
    rest.sort((a, b) => brandRank(a) - brandRank(b) || b.baseMax - a.baseMax);
  } else {
    rest.sort((a, b) => b.baseMax - a.baseMax);
  }
  tables[key].splice(0, table.length, ...rest, ...other);
}

valuation._meta = {
  generatedAt: new Date().toISOString(),
  strategy: STRATEGY,
  sources: Object.entries(market.sources).map(([id, s]) => ({ id, name: s.name, date: s.date })),
};

// ── 2. Catalog UK-used prices ────────────────────────────────────────────────
const catalogChanges = [];
for (const [slug, deviceId] of Object.entries(CATALOG_MAP)) {
  const product = catalog.phones.find((p) => p.id === slug);
  const base = priced.get(deviceId);
  if (!product || !base || base.basis === "new") continue;
  const price = round5k(base.price * (1 + MARKUP / 100));
  if (price !== product.priceUkUsed) {
    catalogChanges.push({ slug, from: product.priceUkUsed, to: price });
    product.priceUkUsed = price;
  }
  if (product.priceUkUsed >= product.priceBrandNew)
    console.warn(`  ! ${slug}: UK-used ₦${price.toLocaleString()} ≥ brand-new ₦${product.priceBrandNew.toLocaleString()} — review its brand-new price`);
}

// ── Report ───────────────────────────────────────────────────────────────────
const section = (title, rows) => {
  console.log(`\n${title} (${rows.length})`);
  rows.forEach((r) => console.log("  " + r));
};
console.log(`Strategy: ${STRATEGY}${MARKUP ? `, catalog markup ${MARKUP}%` : ""}`);
section("Valuation prices changed", report.updated);
section("Valuation devices added", report.added);
section("Valuation devices NOT in any price list (kept old price — review)", report.legacy);
section("Priced from brand-new quotes (no UK-used quote available)", report.newBasis);
section(
  "Catalog UK-used prices changed",
  catalogChanges.map((c) => `${c.slug}  ₦${c.from.toLocaleString()} → ₦${c.to.toLocaleString()}`)
);

if (DRY_RUN) {
  console.log("\nDry run — nothing written.");
  process.exit(0);
}

writeJson("valuationDevices.json", valuation);
writeJson("catalog.json", catalog);
console.log("\nWrote data/valuationDevices.json and data/catalog.json");

if (!UPDATE_DB) process.exit(0);

(async () => {
  const mongoose = require("mongoose");
  const Product = require("../models/Product");
  const ValuationDevice = require("../models/ValuationDevice");
  await mongoose.connect(process.env.MONGO_URI);

  const sourceName = (id) => market.sources[id]?.name || id;
  let v = 0;
  for (const device of market.devices) {
    const base = priced.get(device.id);
    if (!base) continue;
    const table = tables[device.subType].find((d) => d.id === device.id);
    const res = await ValuationDevice.updateOne(
      { deviceId: device.id },
      {
        $set: {
          category: "phone",
          subType: device.subType,
          name: device.name,
          storage: device.storage,
          quotes: device.quotes.map((q) => ({ ...q, source: sourceName(q.source) })),
          priceSource: "market",
          basis: base.basis,
          baseMax: table.baseMax,
          baseMin: table.baseMin,
          isActive: true,
        },
      },
      { upsert: true }
    );
    v += res.modifiedCount + res.upsertedCount;
  }
  console.log(`Synced ${v} valuation device(s) in the database.`);
  let n = 0;
  for (const [slug] of Object.entries(CATALOG_MAP)) {
    const product = catalog.phones.find((p) => p.id === slug);
    if (!product) continue;
    const res = await Product.updateOne(
      { slug },
      { priceUkUsed: product.priceUkUsed }
    );
    n += res.modifiedCount;
  }
  console.log(`Updated ${n} product price(s) in the database.`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
