// The backup file format, shared by scripts/backup.js and scripts/restore.js.
//
// A backup is every collection as Extended JSON lines (types like ObjectId
// and Date survive), gzipped, then encrypted with AES-256-GCM using a key
// derived from BACKUP_PASSPHRASE. The repo is public and GitHub Actions
// artifacts can be downloaded by others, so backups are never stored
// unencrypted. GCM also detects a corrupted or tampered file.
//
// Layout: "TNBK1" | salt (16) | iv (12) | ciphertext | auth tag (16)
const crypto = require("crypto");
const zlib = require("zlib");

const MAGIC = Buffer.from("TNBK1");

const keyFor = (passphrase, salt) => crypto.scryptSync(passphrase, salt, 32);

const checkPassphrase = (passphrase) => {
  if (!passphrase || passphrase.length < 16)
    throw new Error("BACKUP_PASSPHRASE must be set and at least 16 characters long.");
};

/** @param {string} text NDJSON  @returns {Buffer} the encrypted file */
const seal = (text, passphrase) => {
  checkPassphrase(passphrase);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(zlib.gzipSync(text)), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, cipher.getAuthTag()]);
};

/** @returns {string} the NDJSON inside, or throws on a wrong passphrase / damaged file */
const open = (file, passphrase) => {
  checkPassphrase(passphrase);
  if (file.length < MAGIC.length + 44 || !file.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("This isn't a TechNest backup file.");
  const salt = file.subarray(5, 21);
  const iv = file.subarray(21, 33);
  const tag = file.subarray(file.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyFor(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  try {
    const gz = Buffer.concat([decipher.update(file.subarray(33, file.length - 16)), decipher.final()]);
    return zlib.gunzipSync(gz).toString("utf8");
  } catch {
    throw new Error("Couldn't open the backup — wrong passphrase, or the file is damaged.");
  }
};

module.exports = { seal, open };
