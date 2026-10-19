// Server-side port of the frontend's calculateValuation (app/data/gadget.ts).
// Swap offers are valued here rather than trusting a client-sent number,
// since that number decides how much the buyer is charged as a top-up.
//
// Device base prices live in the ValuationDevice collection (editable from
// the admin price tools). They're held in an in-memory cache so valuation
// stays synchronous; call reloadDevices() after changing them. Until the
// cache has loaded (or if the DB is unreachable), the JSON seed file is used.
const seedTables = require("../data/valuationDevices.json");
const market = require("../data/marketPrices.json");
const REPAIRS = new Map(require("../data/repairs.json").map((r) => [r.id, r]));

const LAPTOP_TYPES = ["macbook", "windows", "linux", "gaming"];

let tables = {
  iphone: seedTables.iphone,
  android: seedTables.android,
  laptop: seedTables.laptop,
};
let meta = {
  updatedAt: seedTables._meta?.generatedAt || null,
  sources: seedTables._meta?.sources || [],
};

const toEntry = (d) => ({
  id: d.deviceId,
  name: d.name,
  storage: d.storage,
  baseMin: d.baseMin,
  baseMax: d.baseMax,
  ram: d.ram || undefined,
  chip: d.chip || undefined,
  display: d.display || undefined,
  priceSource: d.priceSource,
  basis: d.basis || undefined,
  // When the price was last backed by a dealer quote — drives confidence
  pricedAt: (d.quotes || []).reduce((m, q) => (q.addedAt > m ? q.addedAt : m), null),
});

// First boot on an empty database: copy the JSON tables (with their dealer
// quotes) into ValuationDevice so admins can edit them from then on.
const seedIfEmpty = async (ValuationDevice) => {
  if (await ValuationDevice.estimatedDocumentCount()) return 0;

  const quotesById = new Map(market.devices.map((d) => [d.id, d.quotes]));
  const sourceName = (id) => market.sources[id]?.name || id;
  const docs = [];
  const add = (entry, category, subType, i) =>
    docs.push({
      deviceId: entry.id,
      category,
      subType,
      name: entry.name,
      storage: entry.storage || "",
      ram: entry.ram || null,
      chip: entry.chip || null,
      display: entry.display || null,
      baseMin: entry.baseMin,
      baseMax: entry.baseMax,
      priceSource: entry.id.startsWith("other-")
        ? "manual"
        : entry.priceSource === "market"
        ? "market"
        : "legacy",
      basis: entry.basis || null,
      quotes: (quotesById.get(entry.id) || []).map((q) => ({
        ...q,
        source: sourceName(q.source),
      })),
      sortOrder: i,
    });

  seedTables.iphone.forEach((e, i) => add(e, "phone", "iphone", i));
  seedTables.android.forEach((e, i) => add(e, "phone", "android", i));
  for (const t of LAPTOP_TYPES)
    (seedTables.laptop[t] || []).forEach((e, i) => add(e, "laptop", t, i));

  await ValuationDevice.insertMany(docs, { ordered: false });
  return docs.length;
};

/** Load (and on first run, seed) devices from the database into the cache. */
const reloadDevices = async () => {
  const ValuationDevice = require("../models/ValuationDevice");
  const seeded = await seedIfEmpty(ValuationDevice);
  if (seeded) console.log(`Seeded ${seeded} valuation devices from data/valuationDevices.json`);

  const docs = await ValuationDevice.find({ isActive: true }).sort({ sortOrder: 1, baseMax: -1 });
  const sortTable = (list) => {
    // Priciest (≈ newest) first, "Other (type manually)" always last
    const other = list.filter((d) => d.id.startsWith("other-"));
    const rest = list.filter((d) => !d.id.startsWith("other-")).sort((a, b) => b.baseMax - a.baseMax);
    return [...rest, ...other];
  };
  const bySub = (sub) => sortTable(docs.filter((d) => d.subType === sub).map(toEntry));

  tables = {
    iphone: bySub("iphone"),
    android: bySub("android"),
    laptop: Object.fromEntries(LAPTOP_TYPES.map((t) => [t, bySub(t)])),
  };

  // Where the prices came from — distinct quote sources, newest first
  const sources = new Map();
  for (const d of docs)
    for (const q of d.quotes) {
      const prev = sources.get(q.source);
      if (!prev || q.addedAt > prev) sources.set(q.source, q.addedAt);
    }
  const latest = docs.reduce((m, d) => (d.updatedAt > m ? d.updatedAt : m), new Date(0));
  meta = {
    updatedAt: docs.length ? latest.toISOString() : null,
    sources: [...sources.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, addedAt]) => ({ name, addedAt })),
  };
  return docs.length;
};

const getDevices = (category, subType) => {
  if (!category || !subType) return [];
  if (category === "phone")
    return subType === "iphone" ? tables.iphone : subType === "android" ? tables.android : [];
  if (category === "laptop") return tables.laptop[subType] || [];
  return [];
};

const getAllDevices = () => tables;
const getMeta = () => meta;

// ── What lowers a price ─────────────────────────────────────────────────────
// Faults a buyer would have to fix are priced from our own repair price list
// (data/repairs.json), scaled by how pricey the device is — a cracked
// screen costs far more to fix on a flagship. Faults that can't be cleanly
// fixed, and things that make a device harder to resell, are percentages.
const FAULTS = {
  screen_cracked: { label: "Cracked screen", repair: { phone: (base) => (base < 400000 ? "screen-replacement-budget" : "screen-replacement-oem"), laptop: "screen-replacement-laptop" } },
  display_fault: { label: "Lines, dead pixels or touch problems on the screen", repair: { phone: (base) => (base < 400000 ? "screen-replacement-budget" : "screen-replacement-oem"), laptop: "screen-replacement-laptop" } },
  back_cracked: { label: "Cracked back glass", repair: { phone: "back-glass-replacement" } },
  charging_port: { label: "Charging port problem", repair: { phone: "charging-port-repair", laptop: "charging-port-repair" } },
  speaker_mic: { label: "Speaker or microphone problem", repair: { phone: "speaker-mic-repair", laptop: "speaker-mic-repair" } },
  buttons: { label: "Buttons not working", repair: { phone: "button-repair" } },
  camera_fault: { label: "Camera not working properly", repair: { phone: "camera-repair" } },
  keyboard_fault: { label: "Keyboard or trackpad problem", repair: { laptop: "keyboard-repair-laptop" } },
  overheating: { label: "Overheating or loud fan", repair: { laptop: "fan-cleaning-repair" } },
  water_damage: { label: "Has been in water (hidden damage risk)", percent: -0.25 },
  network_fault: { label: "No network signal / SIM not detected", percent: -0.3, phoneOnly: true },
  wifi_bluetooth: { label: "Wi-Fi or Bluetooth problem", percent: -0.15 },
  parts_warning: { label: "Shows an unknown / non-genuine part message", percent: -0.07, phoneOnly: true },
};
const FAULT_IDS = Object.keys(FAULTS);

const COSMETIC = {
  like_new: null,
  good: { label: "Light scratches or marks", percent: -0.04 },
  fair: { label: "Visible scratches, scuffs or small dents", percent: -0.1 },
  poor: { label: "Heavy wear, deep scratches or dents", percent: -0.2 },
};

// Repair cost for this device: the cheap end of the repair's price range
// for a ₦100k device, the dear end from ₦1.5m up, rounded to ₦500
const repairCost = (repairId, basePrice) => {
  const r = REPAIRS.get(repairId);
  if (!r) return 0;
  const position = Math.min(1, Math.max(0, (basePrice - 100000) / 1400000));
  return Math.round((r.priceMin + (r.priceMax - r.priceMin) * position) / 500) * 500;
};

// How much to trust the base price, and how wide a range to show because of
// it. min/max stay at ±3% — listings use max as the asking price and swaps
// use the midpoint — so this only widens the "likely range" shown to people.
const confidenceFor = (device, isCustom) => {
  if (isCustom) return { level: "low", reason: "Priced from the amount you entered — we don't have market data for this device.", spread: 0.08 };
  const freshDays = device.pricedAt ? (Date.now() - new Date(device.pricedAt)) / 864e5 : Infinity;
  if (device.priceSource === "market" && freshDays <= 90)
    return { level: "high", reason: "Based on dealer prices from the last 3 months.", spread: 0.03 };
  if (device.priceSource === "market" || device.priceSource === "manual")
    return { level: "medium", reason: "Based on dealer prices that are a few months old.", spread: 0.05 };
  return { level: "medium", reason: "Based on our standard price list, not a recent dealer quote.", spread: 0.05 };
};

const ACCOUNT_LOCKED =
  "Devices still signed in to someone's iCloud or Google account can't be sold or swapped — nobody else can use them. Sign out of the account first, then try again.";

/**
 * @param {object} input condition report — same field names as the
 *   frontend's valuation FormData: category, subType, deviceId,
 *   customDeviceName, customDevicePrice, batteryHealth, batteryChanged,
 *   screenChanged, cameraChanged, faceIdStatus, simType, keyboardChanged,
 *   ramUpgraded, storageUpgraded, otherRepairs — plus the optional
 *   cosmeticGrade (like_new | good | fair | poor), faults (ids from
 *   FAULT_IDS), snapchatStatus, batteryCycleCount and accountLocked.
 *   Leaving the newer fields out gives the same result as before.
 * @returns null if the device can't be priced, { blocked } if it mustn't be
 */
const calculateValuation = (input = {}) => {
  if (input.accountLocked === true) return { blocked: ACCOUNT_LOCKED };
  const deviceId = String(input.deviceId || "");
  const isOther = deviceId.startsWith("other-");
  const device = getDevices(input.category, input.subType).find(
    (d) => d.id === deviceId
  );
  if (!device && !isOther) return null;

  let basePrice, deviceName, deviceStorage;
  if (isOther) {
    basePrice = Number(input.customDevicePrice) || 0;
    deviceName = String(input.customDeviceName || "Custom Device").slice(0, 150);
    deviceStorage = "";
    if (!basePrice || basePrice < 0) return null;
  } else {
    basePrice = device.baseMax;
    deviceName = device.name;
    deviceStorage = device.storage;
  }
  const kind = input.category === "laptop" ? "laptop" : "phone";

  const breakdown = [];

  const battery = Number(input.batteryHealth ?? 100);
  if (battery < 80) breakdown.push({ label: "Battery health below 80%", percent: -0.2 });
  else if (battery < 85) breakdown.push({ label: "Battery health 80–84%", percent: -0.12 });
  else if (battery < 90) breakdown.push({ label: "Battery health 85–89%", percent: -0.07 });
  else if (battery < 95) breakdown.push({ label: "Battery health 90–94%", percent: -0.03 });
  if (kind === "laptop" && Number(input.batteryCycleCount) > 1000)
    breakdown.push({ label: "Battery over 1,000 charge cycles", percent: -0.08 });

  if (input.batteryChanged)
    breakdown.push({ label: "Battery replaced (non-original)", percent: -0.05 });
  if (input.screenChanged) breakdown.push({ label: "Screen replaced", percent: -0.12 });
  if (input.cameraChanged)
    breakdown.push({ label: "Camera replaced/repaired", percent: -0.08 });
  if (input.faceIdStatus === "broken")
    breakdown.push({ label: "Face ID not working", percent: -0.15 });

  if (input.simType === "locked")
    breakdown.push({ label: "Carrier locked", percent: -0.2 });
  else if (input.simType === "esim-unlocked")
    breakdown.push({ label: "eSIM only (no physical SIM)", percent: -0.1 });

  if (input.keyboardChanged) breakdown.push({ label: "Keyboard replaced", percent: -0.08 });
  if (input.ramUpgraded) breakdown.push({ label: "RAM upgraded", percent: 0.05 });
  if (input.storageUpgraded) breakdown.push({ label: "Storage upgraded", percent: 0.05 });
  if (typeof input.otherRepairs === "string" && input.otherRepairs.trim())
    breakdown.push({ label: "Other repairs noted", percent: -0.05 });

  const cosmetic = COSMETIC[input.cosmeticGrade];
  if (cosmetic) breakdown.push({ ...cosmetic });
  if (kind === "phone" && input.snapchatStatus === "banned")
    breakdown.push({ label: "Snapchat banned on this device (many buyers won't take it)", percent: -0.1 });

  // Faults: percentage ones join the list above; fixable ones cost a repair
  const faults = [...new Set(Array.isArray(input.faults) ? input.faults : [])].filter((f) => FAULTS[f]);
  const repairs = [];
  for (const id of faults) {
    const f = FAULTS[id];
    if (f.percent !== undefined) {
      if (!(f.phoneOnly && kind === "laptop")) breakdown.push({ label: f.label, percent: f.percent });
      continue;
    }
    const repair = f.repair[kind];
    if (!repair) continue; // e.g. a keyboard fault on a phone
    const amount = repairCost(typeof repair === "function" ? repair(basePrice) : repair, basePrice);
    if (amount) repairs.push({ label: `${f.label} — about ₦${amount.toLocaleString()} to fix`, amount: -amount });
  }

  const rawDeduction = breakdown.reduce((sum, item) => sum - item.percent, 0);
  const deduction = Math.max(-0.1, Math.min(rawDeduction, 0.65));
  const repairTotal = repairs.reduce((sum, r) => sum - r.amount, 0);
  // A device with every fault still has value for parts
  const valuedPrice = Math.max(Math.round(basePrice * (1 - deduction)) - repairTotal, Math.round(basePrice * 0.15));

  const confidence = confidenceFor(device, isOther);
  return {
    deviceId,
    deviceName,
    deviceStorage,
    isCustom: isOther,
    basePrice,
    breakdown: [
      ...breakdown.map((b) => ({ ...b, amount: Math.round(basePrice * b.percent) })),
      ...repairs.map((r) => ({ ...r, percent: Math.round((r.amount / basePrice) * 100) / 100 })),
    ],
    deductionPercent: Math.round(deduction * 100),
    repairDeduction: repairTotal,
    deductionCapped: rawDeduction > 0.65 || undefined,
    confidence: { level: confidence.level, reason: confidence.reason },
    likelyRange: {
      min: Math.round(valuedPrice * (1 - confidence.spread)),
      max: Math.round(valuedPrice * (1 + confidence.spread)),
    },
    pricedAt: device?.pricedAt || null,
    minVal: Math.round(valuedPrice * 0.97),
    maxVal: Math.round(valuedPrice * 1.03),
  };
};

// Only these condition fields are stored on a swap — keeps arbitrary
// client junk out of the database.
const CONDITION_FIELDS = [
  "category",
  "subType",
  "deviceId",
  "customDeviceName",
  "customDevicePrice",
  "batteryHealth",
  "batteryChanged",
  "screenChanged",
  "cameraChanged",
  "faceIdStatus",
  "simType",
  "keyboardChanged",
  "ramUpgraded",
  "storageUpgraded",
  "otherRepairs",
  "cosmeticGrade",
  "snapchatStatus",
  "batteryCycleCount",
  "faults",
];

const pickCondition = (input = {}) => {
  const out = {};
  for (const key of CONDITION_FIELDS) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[key] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
    else if (key === "faults" && Array.isArray(v)) out[key] = v.filter((f) => FAULTS[f]);
  }
  return out;
};

module.exports = {
  FAULT_IDS,
  FAULTS,
  COSMETIC,
  calculateValuation,
  pickCondition,
  getDevices,
  getAllDevices,
  getMeta,
  reloadDevices,
};
