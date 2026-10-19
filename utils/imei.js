// IMEI handling shared by listings, the public IMEI check and the stolen
// registry. Everything here is free — no paid lookup service is involved:
//   - format + Luhn check digit catches typos and invented numbers
//   - the first 8 digits (TAC) identify the make/model, looked up in our own
//     TacDevice table
//   - duplicates and stolen reports are matched on a keyed hash, so the
//     full IMEI never sits in the database in plain text
const crypto = require("crypto");
const Listing = require("../models/Listing");
const StolenReport = require("../models/StolenReport");
const TacDevice = require("../models/TacDevice");
const { notify } = require("./notify");
const { normalizeDeviceName } = require("./textParsing");
const { splitCsvLine, detectSeparator } = require("./csv");

// Luhn check digit for the 14-digit IMEI body: double every second digit
// counting from the right of the body, sum the digits, round up to 10.
const luhnCheckDigit = (body14) => {
  let sum = 0;
  for (let i = 0; i < body14.length; i++) {
    let d = Number(body14[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
};

const BAD_IMEI =
  "That IMEI doesn't look right. Dial *#06# on the phone and copy the 15-digit number exactly.";

/**
 * Normalizes what a user typed into a full 15-digit IMEI.
 * Accepts spaces/dashes/slashes, a 14-digit IMEI without its check digit,
 * or a 16-digit IMEISV (software version in place of the check digit).
 * @returns {{ imei, tac, last4 } | { error }}
 */
const parseImei = (input) => {
  const digits = String(input ?? "").replace(/\D/g, "");
  let imei;
  if (digits.length === 15) {
    if (luhnCheckDigit(digits.slice(0, 14)) !== digits[14]) return { error: BAD_IMEI };
    imei = digits;
  } else if (digits.length === 14 || digits.length === 16) {
    const body = digits.slice(0, 14);
    imei = body + luhnCheckDigit(body);
  } else {
    return { error: BAD_IMEI };
  }
  // Placeholder numbers (all zeros, 111111111111116…) pass Luhn but aren't real
  if (/^(\d)\1{13}/.test(imei) || imei.startsWith("00000000")) return { error: BAD_IMEI };
  return { imei, tac: imei.slice(0, 8), last4: imei.slice(-4) };
};

// IMEIs are short and structured enough to brute-force a plain hash, so the
// hash is keyed. Changing IMEI_HASH_SECRET orphans every stored hash —
// set it once and never rotate it.
const hashImei = (imei) =>
  crypto.createHmac("sha256", process.env.IMEI_HASH_SECRET).update(imei).digest("hex");

const OPEN_LISTING_STATUSES = ["pending_review", "active"];

// Sellers type "Tecno Spark 20" or just "Spark 20" — drop the brand word so
// both compare equal to the table's model
const withoutBrand = (name, brand) =>
  String(name || "").replace(
    new RegExp(`\\b${String(brand || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
    " "
  );

/** Compares the model the TAC says against what the seller typed. */
const compareModel = async (tac, deviceName) => {
  const entry = await TacDevice.findOne({ tac, active: true }).lean();
  if (!entry) return { modelMatch: "unknown", tacBrand: null, tacModel: null };
  const same =
    deviceName &&
    normalizeDeviceName(withoutBrand(entry.model, entry.brand)) ===
      normalizeDeviceName(withoutBrand(deviceName, entry.brand));
  return {
    modelMatch: same ? "match" : "mismatch",
    tacBrand: entry.brand,
    tacModel: entry.model,
  };
};

const findOpenStolenReport = (imeiHash) =>
  StolenReport.findOne({ imeiHash, status: { $in: ["pending", "confirmed"] } })
    // Confirmed beats pending if somehow both exist
    .sort({ status: 1 });

// Every time a reported IMEI turns up we log it for the owner/police and
// alert the reporter — at most once an hour so repeat checks can't spam them.
const recordStolenHit = async (report, context, userId) => {
  const now = new Date();
  const shouldAlert =
    !report.lastAlertAt || now - report.lastAlertAt > 60 * 60 * 1000;

  await StolenReport.updateOne(
    { _id: report._id },
    {
      $push: { hits: { $each: [{ at: now, context, user: userId || null }], $slice: -100 } },
      ...(shouldAlert ? { $set: { lastAlertAt: now } } : {}),
    }
  );

  if (shouldAlert) {
    await notify({
      recipient: report.reporter,
      type: "stolen_device_alert",
      title: "Your reported device was checked",
      message:
        context === "listing"
          ? `Someone tried to list your ${report.brand} ${report.model} (IMEI ending ${report.imeiLast4}) on TechNest. We blocked it.`
          : `Someone checked the IMEI of your ${report.brand} ${report.model} (ending ${report.imeiLast4}) on TechNest.`,
    });
  }
};

/**
 * Full screening for an IMEI attached to a listing.
 * @returns {{ status, error } | { fields }} fields are ready to set on the listing
 */
const screenListingImei = async ({ imei, deviceName, ownerId, listingId = null }) => {
  const parsed = parseImei(imei);
  if (parsed.error) return { status: 400, error: parsed.error };
  const imeiHash = hashImei(parsed.imei);

  const report = await findOpenStolenReport(imeiHash);
  if (report) {
    await recordStolenHit(report, "listing", ownerId);
    return {
      status: 409,
      error:
        "This device has been reported stolen, so it can't be listed. If you think this is a mistake, contact support.",
    };
  }

  const duplicate = await Listing.findOne({
    imeiHash,
    status: { $in: OPEN_LISTING_STATUSES },
    ...(listingId ? { _id: { $ne: listingId } } : {}),
  }).select("owner");
  if (duplicate) {
    const yours = String(duplicate.owner) === String(ownerId);
    return {
      status: 409,
      error: yours
        ? "You already have an open listing for this device."
        : "This device is already listed on TechNest. If it's yours, contact support.",
    };
  }

  const check = await compareModel(parsed.tac, deviceName);
  return {
    fields: {
      imeiHash,
      imeiLast4: parsed.last4,
      imeiTac: parsed.tac,
      imeiVerified: true,
      imeiCheck: { ...check, checkedAt: new Date() },
    },
  };
};

// Model names people type usually start with a product line, not the brand
const LINE_BRANDS = [
  [/^(iphone|ipad|macbook)/i, "Apple"],
  [/^galaxy/i, "Samsung"],
  [/^pixel/i, "Google"],
  [/^(redmi|poco)/i, "Xiaomi"],
  [/^(spark|camon|pova|phantom)/i, "Tecno"],
  [/^(hot|note|zero|smart)\s*\d/i, "Infinix"],
];

const guessBrand = (subType, deviceName) => {
  const name = String(deviceName || "").trim();
  if (/^(iphone|ipad|macbook)/i.test(subType || "")) return "Apple";
  const line = LINE_BRANDS.find(([re]) => re.test(name));
  if (line) return line[1];
  const first = name.split(/\s+/)[0] || "Unknown";
  return first.charAt(0).toUpperCase() + first.slice(1);
};

// When an admin approves a listing whose TAC we didn't know, remember it —
// the admin has looked at the photos, so this is a reasonable first guess.
// Admin-entered and imported codes are never overwritten.
const learnTacFromListing = async (listing) => {
  if (!listing.imeiTac || listing.imeiCheck?.modelMatch !== "unknown") return;
  await TacDevice.updateOne(
    { tac: listing.imeiTac },
    {
      $setOnInsert: {
        tac: listing.imeiTac,
        brand: guessBrand(listing.subType, listing.deviceName),
        model: listing.deviceName,
        deviceType: listing.deviceCategory === "tablet" ? "tablet" : "phone",
        source: "learned",
        active: true,
      },
    },
    { upsert: true }
  );
};

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bIp(hone|ad|od)\b/g, "iP$1")
    .replace(/\b(\d)g\b/g, "$1G");

// "SPECS" cells look like "TECNO SPARK 20 PRO 5G, Tecno HK KJ8, 2024" or
// "INFINIX, INFINIX HOT 40" — the model is the first part that isn't just
// the brand, with the brand word dropped
const modelFromSpecs = (specs, brand) => {
  const parts = specs.split(",").map((p) => p.trim()).filter(Boolean);
  const named = parts.find((p) => withoutBrand(p, brand).trim()) || "";
  return titleCase(withoutBrand(named, brand).replace(/\s+/g, " ").trim());
};

/**
 * Parses a TAC list. Two layouts are understood:
 *   - ours: "tac,brand,model[,deviceType]" (header optional)
 *   - public lists with a header naming the columns, e.g. "Brand,TAC,SPECS"
 *     (github.com/MoazEb/tac-database)
 * Comma, tab or semicolon separated. Codes that lost their leading zero
 * (spreadsheets do this) are padded back to 8 digits.
 * @returns {{ rows, problems }}
 */
const parseTacCsv = (text) => {
  const rows = [];
  const problems = [];
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);
  const first = lines.find((l) => l.trim()) || "";
  const sep = detectSeparator(first);

  // Column positions from a header row, if there is one
  let col = { tac: 0, brand: 1, model: 2, deviceType: 3, specs: -1 };
  let start = 0;
  const header = splitCsvLine(first, sep).map((h) => h.toLowerCase());
  if (!/^\d/.test(header[0] || "")) {
    const at = (name) => header.indexOf(name);
    col = { tac: at("tac"), brand: at("brand"), model: at("model"), deviceType: at("devicetype"), specs: at("specs") };
    start = lines.indexOf(first) + 1;
    if (col.tac < 0 || col.brand < 0 || (col.model < 0 && col.specs < 0))
      return { rows, problems: ["The header must name the tac, brand and model (or specs) columns."] };
  }

  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cells = splitCsvLine(lines[i], sep);
    const rawTac = (cells[col.tac] || "").replace(/\D/g, "");
    const tac = rawTac.length === 7 ? `0${rawTac}` : rawTac;
    const brand = titleCase(cells[col.brand] || "");
    const model =
      col.model >= 0 ? cells[col.model] || "" : modelFromSpecs(cells[col.specs] || "", brand);
    if (tac.length !== 8) {
      problems.push(`Line ${i + 1}: the code must be exactly 8 digits.`);
      continue;
    }
    if (!brand || !model) {
      problems.push(`Line ${i + 1}: both the make and the model are needed.`);
      continue;
    }
    if (seen.has(tac)) {
      problems.push(`Line ${i + 1}: code ${tac} appears twice — the repeat was skipped.`);
      continue;
    }
    seen.add(tac);
    const deviceType = col.deviceType >= 0 ? cells[col.deviceType] : "";
    rows.push({
      tac,
      brand: brand.slice(0, 50),
      model: model.slice(0, 100),
      deviceType: ["phone", "tablet", "wearable", "other"].includes(deviceType) ? deviceType : "phone",
    });
  }
  return { rows, problems };
};

// Upserts parsed CSV rows in batches (public lists run to 250k+ lines).
// Entries an admin typed in by hand win over imports, so a bulk list can't
// undo a correction.
const importTacRows = async (rows, userId = null, onProgress = null) => {
  const total = { added: 0, updated: 0, skippedManual: 0 };
  const BATCH = 5000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const manual = new Set(
      (await TacDevice.find({ tac: { $in: batch.map((r) => r.tac) }, source: "manual" }).select("tac"))
        .map((d) => d.tac)
    );
    const ops = batch
      .filter((r) => !manual.has(r.tac))
      .map((r) => ({
        updateOne: {
          filter: { tac: r.tac },
          update: { $set: { ...r, source: "import", active: true, updatedBy: userId } },
          upsert: true,
        },
      }));
    if (ops.length) {
      const res = await TacDevice.bulkWrite(ops, { ordered: false });
      total.added += res.upsertedCount;
      total.updated += res.modifiedCount;
    }
    total.skippedManual += manual.size;
    if (onProgress) onProgress(Math.min(i + BATCH, rows.length), rows.length);
  }
  return total;
};

module.exports = {
  luhnCheckDigit,
  parseImei,
  hashImei,
  compareModel,
  findOpenStolenReport,
  recordStolenHit,
  screenListingImei,
  learnTacFromListing,
  parseTacCsv,
  importTacRows,
  OPEN_LISTING_STATUSES,
};
