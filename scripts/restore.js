// Restores a backup made by scripts/backup.js.
//
//   node scripts/restore.js technest.tnbk --list
//       show what's inside (no database needed)
//   node scripts/restore.js technest.tnbk --to "<mongodb uri>"
//       restore into that database — refuses collections that already have
//       data, so nothing is overwritten by accident
//   ... --only users,listings     restore just these collections
//   ... --drop                    empty those collections first (careful)
//
// Needs BACKUP_PASSPHRASE. The target must be given with --to on purpose:
// restoring is never pointed at MONGO_URI by default. Tip: restore into a
// new, empty database first and check it before switching the app over.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const mongoose = require("mongoose");
const { open } = require("../utils/backupFormat");

const { EJSON } = mongoose.mongo.BSON;
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};

const run = async () => {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("Usage: node scripts/restore.js <backup file> --list | --to <mongodb uri>");
  const [metaLine, ...lines] = open(fs.readFileSync(file), process.env.BACKUP_PASSPHRASE).split("\n");
  const meta = JSON.parse(metaLine);
  const only = arg("--only") ? new Set(arg("--only").split(",").map((s) => s.trim())) : null;

  console.log(`Backup from ${meta.createdAt} (database "${meta.database}")`);
  for (const c of meta.collections) if (!only || only.has(c.name)) console.log(`  ${c.name}: ${c.count}`);
  if (process.argv.includes("--list")) return;

  const target = arg("--to");
  if (!target) throw new Error("Say where to restore with --to <mongodb uri> (or use --list to just look).");

  // Group documents by collection
  const byCollection = new Map();
  for (const line of lines) {
    if (!line) continue;
    const { c, d } = EJSON.parse(line, { relaxed: false });
    if (only && !only.has(c)) continue;
    if (!byCollection.has(c)) byCollection.set(c, []);
    byCollection.get(c).push(d);
  }

  await mongoose.connect(target);
  const db = mongoose.connection.db;
  const drop = process.argv.includes("--drop");
  const busy = [];
  for (const name of byCollection.keys())
    if ((await db.collection(name).estimatedDocumentCount()) > 0) busy.push(name);
  if (busy.length && !drop) {
    await mongoose.disconnect();
    throw new Error(`These collections already have data: ${busy.join(", ")}. Restore into an empty database, or add --drop to replace them.`);
  }

  // Recreate empty collections too, so the copy matches the original
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const { name, count } of meta.collections)
    if (count === 0 && (!only || only.has(name)) && !existing.has(name)) await db.createCollection(name);

  for (const [name, docs] of byCollection) {
    if (drop) await db.collection(name).deleteMany({});
    for (let i = 0; i < docs.length; i += 5000) await db.collection(name).insertMany(docs.slice(i, i + 5000), { ordered: false });
    console.log(`Restored ${docs.length} into ${name}`);
  }
  console.log("Done. Indexes are rebuilt by the app when it next starts.");
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
