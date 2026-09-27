// Free, rule-based checks shown to admins when reviewing a listing. They
// always run (no AI needed); AI review, when available, adds to them.
const Listing = require("../models/Listing");
const { getAllDevices } = require("./valuation");
const { normalizeDeviceName } = require("./textParsing");

const PHONE_RE = /(?:\+?234|\b0)[789][01]\d{8}\b/;
const ACCOUNT_RE = /\b\d{10}\b/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const CONTACT_WORDS_RE = /\b(whats\s*app|call me|text me|dm me|telegram|pay (?:to|into)|account (?:no|number)|opay|palmpay|moniepoint)\b/i;
const URL_RE = /\bhttps?:\/\/|\bwww\.|\.com\b|\.ng\b/i;

/** Find the valuation device a listing is for, by name + storage. */
const findMarketDevice = (listing) => {
  const tables = getAllDevices();
  const all = [
    ...tables.iphone,
    ...tables.android,
    ...Object.values(tables.laptop).flat(),
  ].filter((d) => !d.id.startsWith("other-"));
  const key = normalizeDeviceName(listing.deviceName);
  const storage = String(listing.storage || "").toUpperCase().replace(/\s+/g, "");
  const sameName = all.filter((d) => normalizeDeviceName(d.name) === key);
  return sameName.find((d) => d.storage.toUpperCase() === storage) || (sameName.length === 1 ? sameName[0] : null);
};

/**
 * @returns {Promise<Array<{code, severity: "high"|"medium"|"info", message}>>}
 */
const runListingChecks = async (listing) => {
  const checks = [];
  const add = (code, severity, message) => checks.push({ code, severity, message });

  const device = findMarketDevice(listing);
  if (device && device.baseMax > 0) {
    const ratio = listing.estimatedMax / device.baseMax;
    if (ratio < 0.5)
      add("price_too_low", "high", `Asking ₦${listing.estimatedMax.toLocaleString()} is under half the market price (₦${device.baseMax.toLocaleString()} for ${device.name} ${device.storage}) — common in scams.`);
    else if (ratio > 1.4)
      add("price_too_high", "info", `Asking ₦${listing.estimatedMax.toLocaleString()} is well above the market price (₦${device.baseMax.toLocaleString()}).`);
  } else {
    add("no_market_price", "info", "No market price on file for this device — check the price by hand.");
  }

  const text = [listing.description, listing.deviceName, listing.wantedDevice, ...(listing.repairs || [])]
    .filter(Boolean)
    .join(" \n ");
  if (PHONE_RE.test(text) || EMAIL_RE.test(text) || CONTACT_WORDS_RE.test(text) || URL_RE.test(text))
    add("contact_details", "high", "The text contains contact or payment details — deals should go through TechNest.");
  else if (ACCOUNT_RE.test(text))
    add("possible_account_number", "medium", "The text contains a 10-digit number that could be a bank account.");

  if (!listing.images?.length) add("no_photos", "medium", "No photos uploaded.");
  else if (listing.images.length < 2) add("few_photos", "info", "Only one photo.");

  if (listing.deviceCategory === "phone" && !listing.imeiVerified)
    add("imei_not_checked", "info", "IMEI checksum wasn't verified.");

  const battery = Number(listing.batteryHealth);
  if (Number.isFinite(battery) && battery > 0 && battery < 80)
    add("low_battery", "info", `Battery health ${battery}%.`);

  const duplicate = await Listing.exists({
    _id: { $ne: listing._id },
    owner: listing.owner?._id || listing.owner,
    deviceName: listing.deviceName,
    storage: listing.storage || null,
    status: { $in: ["pending_review", "active"] },
  });
  if (duplicate) add("duplicate", "medium", "The same seller has another open listing for this device.");

  const owner = listing.owner;
  if (owner?.createdAt && Date.now() - new Date(owner.createdAt).getTime() < 24 * 3600 * 1000)
    add("new_account", "info", "Seller's account is less than a day old.");

  return checks;
};

// Plain description built from the form — the free alternative to AI writing it
const templateDescription = (f = {}) => {
  const parts = [];
  const name = [f.deviceName, f.storage].filter(Boolean).join(" ");
  if (name) parts.push(`${name} in UK-used condition.`);
  const battery = Number(f.batteryHealth);
  if (battery > 0) parts.push(`Battery health ${battery}%.`);
  if (f.simType === "physical") parts.push("Physical SIM + eSIM, unlocked.");
  else if (f.simType === "esim-unlocked") parts.push("eSIM only, unlocked.");
  else if (f.simType === "locked") parts.push("Network locked.");
  if (f.faceIdStatus === "working") parts.push("Face ID works.");
  else if (f.faceIdStatus === "broken") parts.push("Face ID not working.");
  const repairs = Array.isArray(f.repairs) ? f.repairs.filter(Boolean) : [];
  parts.push(repairs.length ? `Repairs/replacements: ${repairs.join(", ")}.` : "No repairs or replaced parts.");
  return parts.join(" ");
};

module.exports = { runListingChecks, templateDescription, findMarketDevice };
