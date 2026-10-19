// End-to-end test of health and downtime handling: /api/health, clear 503s
// while the database is down (the test really stops it), webhooks asking
// to be resent, recovery, and friendlier error responses.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { baseEnv } = require("./helpers/env");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server-core");

const BACKEND = path.resolve(__dirname, "..");
const EMAIL_LOG = path.join(fs.mkdtempSync(path.join(require("os").tmpdir(), "technest-test-")), "emails.jsonl");
const alerts = () => (fs.existsSync(EMAIL_LOG) ? fs.readFileSync(EMAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []).filter((e) => e.body.subject.startsWith("⚠️"));
const PORT = 5108;
let pass = 0, fail = 0;
const t = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  ← " + String(extra).slice(0, 400)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const call = async (method, url, body, headers = {}) => {
  const res = await fetch(`http://localhost:${PORT}${url}`, { method, headers: { "Content-Type": "application/json", ...headers }, body });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
};
const waitFor = async (check, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await check()) return true;
  return false;
};

(async () => {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri("technest_test");
  const env = {
    ...baseEnv(), PORT, MONGO_URI: uri, NODE_ENV: "production",
    JWT_SECRET: "j".repeat(40), JWT_REFRESH_SECRET: "r".repeat(40),
    CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
    IMEI_HASH_SECRET: "h".repeat(40), PAYSTACK_SECRET_KEY: "sk_test_x", RENDER_GIT_COMMIT: "abcdef1234567",
    EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "k", EMAIL_FROM: "alerts@technest.test", EMAIL_LOG, ERROR_ALERT_EMAIL: "ops@t.com, cto@t.com",
  };
  const server = spawn("node", ["server.js"], { cwd: BACKEND, env });
  process.on("exit", () => server.kill());
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 80 && !log.includes("Server running"); i++) await sleep(250);
  if (!log.includes("Server running")) { console.log(log); process.exit(1); }

  let r = await call("GET", "/api/health");
  t("health: 200 ok, database connected, version, services", r.status === 200 && r.json.data.status === "ok" && r.json.data.database === "connected" && r.json.data.version === "abcdef1" && r.json.data.services.payments === true && r.json.data.services.email === true && r.json.data.services.whatsapp === false, J(r.json));

  // Friendlier errors
  r = await call("POST", "/api/auth/login", "{not json");
  t("broken JSON → 400 bad_json", r.status === 400 && r.json.code === "bad_json", J(r.json));
  r = await call("POST", "/api/auth/login", JSON.stringify({ x: "y".repeat(20000) }));
  t("oversized body → 413 too_large", r.status === 413 && r.json.code === "too_large", J(r.json));
  r = await call("GET", "/api/listings", null, { Origin: "https://evil.example" });
  t("unknown website → 403 cors (not a 500)", r.status === 403 && r.json.code === "cors", J(r.json));

  // Take the database away
  await mongo.stop({ doCleanup: false, force: false });
  const sawDown = await waitFor(async () => (await call("GET", "/api/health")).status === 503, 45000);
  r = await call("GET", "/api/health");
  t("health: 503 down when the database stops", sawDown && r.json.data.status === "down", J(r.json));
  const t0 = Date.now();
  r = await call("GET", "/api/listings");
  t("API answers 503 straight away while the database is down", r.status === 503 && r.json.code === "service_unavailable" && r.headers.get("retry-after") === "30" && Date.now() - t0 < 3000, `${r.status} ${J(r.json)} ${Date.now() - t0}ms`);
  r = await call("GET", "/api/docs/");
  t("API docs still load", r.status === 200 || r.status === 301 || r.status === 304);
  const body = JSON.stringify({ event: "charge.success", data: { reference: "TN-x" } });
  const sig = crypto.createHmac("sha512", "sk_test_x").update(body).digest("hex");
  r = await call("POST", "/api/checkout/webhook", body, { "x-paystack-signature": sig });
  t("Paystack webhook asks to be resent (503) instead of losing the payment", r.status === 503);
  r = await call("GET", "/");
  t("server itself stays up", r.status === 200);
  for (let i = 0; i < 5; i++) await call("GET", "/api/listings");
  await sleep(500);
  const down = alerts().filter((e) => /Database disconnected/.test(e.body.subject));
  t("team emailed once about the outage (not once per request)", down.length === 2 && J(down.map((e) => e.body.to[0].email).sort()) === J(["cto@t.com", "ops@t.com"]) && /version abcdef1/.test(down[0].body.textContent), J(alerts().map((e) => e.body.subject)));

  // Bring it back
  await mongo.start(true);
  const back = await waitFor(async () => (await call("GET", "/api/health")).status === 200, 60000);
  t("recovers by itself when the database is back", back, log.split("\n").slice(-5).join(" | "));
  r = await call("GET", "/api/listings");
  t("API works again", r.status === 200, J(r.json));
  t("disconnect was logged", /MongoDB disconnected/.test(log));

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
