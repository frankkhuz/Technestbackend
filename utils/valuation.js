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

/**
 * @param {object} input condition report — same field names as the
 *   frontend's valuation FormData: category, subType, deviceId,
 *   customDeviceName, customDevicePrice, batteryHealth, batteryChanged,
 *   screenChanged, cameraChanged, faceIdStatus, simType, keyboardChanged,
 *   ramUpgraded, storageUpgraded, otherRepairs
 * @returns null if the device can't be priced
 */
const calculateValuation = (input = {}) => {
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

  const breakdown = [];

  const battery = Number(input.batteryHealth ?? 100);
  if (battery < 80) breakdown.push({ label: "Battery health below 80%", percent: -0.2 });
  else if (battery < 85) breakdown.push({ label: "Battery health 80–84%", percent: -0.12 });
  else if (battery < 90) breakdown.push({ label: "Battery health 85–89%", percent: -0.07 });
  else if (battery < 95) breakdown.push({ label: "Battery health 90–94%", percent: -0.03 });

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

  const rawDeduction = breakdown.reduce((sum, item) => sum - item.percent, 0);
  const deduction = Math.max(-0.1, Math.min(rawDeduction, 0.65));
  const valuedPrice = Math.round(basePrice * (1 - deduction));

  return {
    deviceId,
    deviceName,
    deviceStorage,
    isCustom: isOther,
    basePrice,
    breakdown,
    deductionPercent: Math.round(deduction * 100),
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
];

const pickCondition = (input = {}) => {
  const out = {};
  for (const key of CONDITION_FIELDS) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[key] = v.slice(0, 200);
    else if (typeof v === "number" || typeof v === "boolean") out[key] = v;
  }
  return out;
};

module.exports = {
  calculateValuation,
  pickCondition,
  getDevices,
  getAllDevices,
  getMeta,
  reloadDevices,
};
