// Free identity checks — no paid NIN lookup. A person submits an ID
// photo and a selfie (private uploads) plus a bank account; the bank's
// account name (Paystack resolve) is compared with the name on the ID, and
// an admin makes the final call looking at the photos.
const cloudinary = require("../config/cloudinary");

const ID_TYPES = ["nin_slip", "drivers_licence", "international_passport", "voters_card"];

const nameTokens = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t.length > 1);

/**
 * Nigerian account names are usually "SURNAME FIRSTNAME MIDDLENAME", so
 * order is ignored. Two shared names = match, one = partial.
 * @returns {"match"|"partial"|"mismatch"|"unchecked"}
 */
const compareNames = (idName, accountName) => {
  if (!accountName) return "unchecked";
  const id = [...new Set(nameTokens(idName))];
  const account = new Set(nameTokens(accountName));
  const hits = id.filter((t) => account.has(t)).length;
  if (hits >= 2 || (hits === 1 && id.length === 1)) return "match";
  return hits === 1 ? "partial" : "mismatch";
};

/** A private upload must be in the uploader's own folder (see routes/uploads.js). */
const isOwnPrivateUpload = (publicId, userId) =>
  typeof publicId === "string" &&
  new RegExp(`^technest/private/${userId}/[\\w-]+$`).test(publicId);

/** Signed link for admins to view a private upload. */
const privateUrl = (publicId) =>
  publicId
    ? cloudinary.url(publicId, { type: "authenticated", sign_url: true, secure: true })
    : null;

module.exports = { ID_TYPES, compareNames, isOwnPrivateUpload, privateUrl };
