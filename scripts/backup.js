// Encrypted backup of the whole database (see utils/backupFormat.js).
// Runs nightly from .github/workflows/backup.yml; can also be run by hand:
//
//   BACKUP_PASSPHRASE=... node scripts/backup.js --out technest.tnbk
//
// Uses MONGO_URI from the environment (or .env). Keep the passphrase in a
// password manager — without it a backup can't be opened.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const mongoose = require("mongoose");
const { seal } = require("../utils/backupFormat");

const { EJSON } = mongoose.mongo.BSON;

const run = async () => {
  const outIndex = process.argv.indexOf("--out");
  const out = outIndex > -1 ? process.argv[outIndex + 1] : `technest-${new Date().toISOString().slice(0, 10)}.tnbk`;
  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!passphrase || passphrase.length < 16) throw new Error("Set BACKUP_PASSPHRASE (16+ characters).");

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const names = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name)
    .filter((n) => !n.startsWith("system."))
    .sort();

  const lines = [];
  const counts = [];
  for (const name of names) {
    let n = 0;
    for await (const doc of db.collection(name).find()) {
      lines.push(EJSON.stringify({ c: name, d: doc }, { relaxed: false }));
      n++;
    }
    counts.push({ name, count: n });
  }
  const meta = { version: 1, createdAt: new Date().toISOString(), database: db.databaseName, collections: counts };
  const file = seal([JSON.stringify(meta), ...lines].join("\n"), passphrase);
  fs.writeFileSync(out, file);

  const total = counts.reduce((s, c) => s + c.count, 0);
  console.log(`Backed up ${total} documents from ${counts.length} collections → ${out} (${(file.length / 1e6).toFixed(1)} MB, encrypted)`);
  for (const c of counts) console.log(`  ${c.name}: ${c.count}`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
