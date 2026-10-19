// Runs every end-to-end suite in test/ one after another: `npm test`.
// Each suite starts the real server against a throwaway in-memory MongoDB
// (mongodb-memory-server-core downloads a MongoDB binary on first run) with
// email, Paystack, Cloudinary and WhatsApp mocked — nothing real is sent
// and no real database is touched. Run one suite with
// `node test/<name>.test.js`.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const only = process.argv[2];
const suites = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js") && (!only || f.includes(only)))
  .sort();

const results = [];
for (const file of suites) {
  console.log(`\n━━ ${file} ━━`);
  const run = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
  const out = run.stdout || "";
  // Show failures in full, passes as a count
  process.stdout.write(out.split("\n").filter((l) => !l.startsWith("PASS ")).join("\n"));
  const summary = out.match(/(\d+) passed, (\d+) failed/);
  results.push({ file, ok: run.status === 0, summary: summary ? summary[0] : `crashed (exit ${run.status})` });
}

console.log("\n━━ Summary ━━");
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.file}: ${r.summary}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
