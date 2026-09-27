// Free (no-AI) reader for pasted dealer price lists, e.g. WhatsApp messages:
//   "*14 PRO MAX 256GB (Phy + ESIM) -N800k*"
//   "S22ultra 256gb 1sim +esim = 530k"
//   "iPhone Air 512GB - 1,220,000"
// Each line with a price becomes a row, matched to a known valuation device
// where possible. It's deliberately conservative: anything it can't match
// confidently is returned unmatched for the admin to pick the device by hand.
const {
  findPrices,
  parseStorage,
  normalizeDeviceName,
  STORAGE_TOKEN_RE,
} = require("./textParsing");

const detectSim = (line) => {
  const l = line.toLowerCase();
  if (/dual\s*sim|2\s*sim/.test(l)) return "dual-sim";
  if (/phy|physical|1\s*sim|\+\s*e-?sim/.test(l)) return "phys+esim"; // "1sim + esim" = physical + eSIM
  if (/e-?sim/.test(l)) return "esim";
  return null;
};

const detectContext = (line) => {
  const l = line.toLowerCase();
  if (/iphone/.test(l)) return "iphone";
  if (/samsung/.test(l)) return "samsung";
  if (/pixel/.test(l)) return "pixel";
  return null;
};

const cleanName = (line) =>
  line
    .replace(/[*_~]/g, " ")
    .replace(/[\u{1F000}-\u{1FFFF}☀-➿️]/gu, " ") // emoji / flags
    .replace(STORAGE_TOKEN_RE, " ")
    .replace(/\+\s*e-?sim/gi, " ") // "1sim +esim"
    .replace(/\(.*?\)/g, " ")
    .replace(/\|.*$/, " ") // "| FU | N395k" trailers
    .replace(/(?:₦|\bN)?\s*\d{1,3}(?:,\d{3})+/g, " ")
    .replace(/(?:₦|\bN|=|-)\s*\d+(?:\.\d+)?\s*(?:k|m|million)?(?![\w])/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:k|m)\b/gi, " ")
    .replace(/\b(dual\s*sim|2\s*sim|1\s*sim|e-?sim( only)?|phy(sical)?( sim)?|only|new|uk|unlocked|fu)\b/gi, " ")
    .replace(/^\s*\d+\)\s*/, " ") // "1) " list numbering
    .replace(/[=,-]+\s*$/g, " ") // keep a trailing "+" — "S21+" is a model
    .replace(/\s+/g, " ")
    .trim();

/**
 * @param {string} text  the pasted list
 * @param {Array<{id, name, storage}>} devices  known valuation devices
 * @returns {{ rows: Array, ignored: string[] }}
 */
const parsePriceList = (text, devices) => {
  const byKey = new Map();
  const byName = new Map();
  for (const d of devices) {
    if (d.id.startsWith("other-")) continue;
    const nameKey = normalizeDeviceName(d.name);
    byKey.set(`${nameKey}|${(d.storage || "").toUpperCase()}`, d);
    if (!byName.has(nameKey)) byName.set(nameKey, []);
    byName.get(nameKey).push(d);
  }

  let context = null;
  let sectionSim = null; // "PIXEL 10 SERIES ESIM UNLOCKED" applies to the lines below
  const rows = [];
  const ignored = [];

  for (const rawLine of String(text).split(/\r?\n/)) {
    // WhatsApp *bold* / _italic_ / ~strike~ markers break number boundaries
    const line = rawLine.replace(/[*_~]/g, " ").replace(/\s+/g, " ").trim();
    if (!line) continue;

    const prices = findPrices(line);
    if (!prices.length) {
      // Headers like "AVAILABLE USED IPHONES" set the brand for the lines below
      context = detectContext(line) || context;
      sectionSim = detectSim(line) || sectionSim;
      if (line.length > 2) ignored.push(line);
      continue;
    }

    const price = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length);
    const storage = parseStorage(line);
    const sim = detectSim(line) || sectionSim || "phys+esim";
    const condition = /\bnew\b/i.test(line) ? "new" : "uk-used";
    const name = cleanName(line);
    if (!name) {
      ignored.push(line);
      continue;
    }

    // "14 PRO 128GB" under an iPhone header means "iPhone 14 Pro"
    const lineContext = detectContext(line) || context;
    let key = normalizeDeviceName(name);
    // Only bare iPhone-style names ("14 pro", "xr", "se 2nd gen", "air") get the
    // prefix — "s22ultra" or "zflip5" under a stale iPhone header stay as-is
    if (lineContext === "iphone" && /^(\d|x|se|air)/.test(key)) key = `iphone${key}`;
    if (lineContext === "pixel" && /^\d/.test(key)) key = `pixel${key}`;

    let match = storage ? byKey.get(`${key}|${storage}`) : null;
    let storageAssumed = false;
    if (!match && !storage) {
      const sameName = byName.get(key) || [];
      if (sameName.length === 1) {
        match = sameName[0];
        storageAssumed = true;
      }
    }

    const candidates = match
      ? []
      : (byName.get(key) || []).map((d) => ({ id: d.id, name: d.name, storage: d.storage }));

    rows.push({
      line,
      name,
      storage: storage || match?.storage || null,
      price,
      sim,
      condition,
      note: prices.length > 1 ? `listed as ${prices.length} prices; averaged` : undefined,
      deviceId: match ? match.id : null,
      matchedName: match ? `${match.name} ${match.storage}`.trim() : null,
      storageAssumed: storageAssumed || undefined,
      candidates: candidates.length ? candidates : undefined,
    });
  }

  return { rows, ignored };
};

module.exports = { parsePriceList };
