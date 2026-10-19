// Loads IMEI model codes (TACs) from a CSV into the TacDevice collection,
// for lists too big to paste into the admin panel.
//
//   npm run tac:import -- path/to/tac.csv
//
// Accepts our "tac,brand,model[,deviceType]" layout, or a public list with a
// header naming its columns — e.g. tac_full.csv (~255k codes) from
// https://github.com/MoazEb/tac-database, which uses "Brand,TAC,SPECS".
// Safe to re-run: codes are matched by TAC, nothing is deleted, and entries
// an admin typed in by hand are never overwritten.
require("dotenv").config();
const fs = require("fs");
const mongoose = require("mongoose");
const { parseTacCsv, importTacRows } = require("../utils/imei");

const run = async () => {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npm run tac:import -- path/to/tac.csv");
    process.exit(1);
  }

  const { rows, problems } = parseTacCsv(fs.readFileSync(file, "utf8"));
  problems.slice(0, 20).forEach((p) => console.warn(p));
  if (problems.length > 20) console.warn(`…and ${problems.length - 20} more problems.`);
  if (!rows.length) {
    console.error("No valid lines found.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const result = await importTacRows(rows, null, (done, total) =>
    process.stdout.write(`\r${done.toLocaleString()} / ${total.toLocaleString()}`)
  );
  process.stdout.write("\n");
  console.log(
    `TAC import: ${result.added} added, ${result.updated} updated, ${result.skippedManual} kept (edited by an admin), ${rows.length} valid lines.`
  );
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
