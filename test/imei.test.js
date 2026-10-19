// End-to-end test of the IMEI feature against an in-memory MongoDB.
const path = require("path");
const { baseEnv } = require("./helpers/env");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server-core");

const BACKEND = path.resolve(__dirname, "..");
const PORT = 5099;
const BASE = `http://localhost:${PORT}`;
const CLOUD = "testcloud";
let pass = 0, fail = 0;
const t = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  ← " + extra}`);
};

class Client {
  constructor() { this.cookies = {}; }
  async req(method, url, body) {
    const headers = { "Content-Type": "application/json" };
    const c = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (c) headers.Cookie = c;
    if (this.cookies.csrfToken) headers["X-CSRF-Token"] = this.cookies.csrfToken;
    const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";");
      const i = kv.indexOf("=");
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }
}

const listingBody = (over) => ({
  userName: "Seller", userPhone: "08031234567", deviceName: "iPhone X",
  deviceCategory: "phone", subType: "iphone", storage: "64GB",
  estimatedMin: 150000, estimatedMax: 180000,
  images: [`https://res.cloudinary.com/${CLOUD}/image/upload/a.jpg`, `https://res.cloudinary.com/${CLOUD}/image/upload/b.jpg`],
  ...over,
});

(async () => {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri("technest_test");
  const env = {
    ...baseEnv(), PORT, MONGO_URI: uri, NODE_ENV: "development",
    JWT_SECRET: "j".repeat(40), JWT_REFRESH_SECRET: "r".repeat(40),
    CLOUDINARY_CLOUD_NAME: CLOUD, CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
    IMEI_HASH_SECRET: "h".repeat(40), PAYSTACK_SECRET_KEY: "", ANTHROPIC_API_KEY: "",
  };

  // Server refuses to start without the secret
  const noSecret = spawn("node", ["server.js"], { cwd: BACKEND, env: { ...env, IMEI_HASH_SECRET: "" } });
  const code = await new Promise((r) => noSecret.on("exit", r));
  t("server exits without IMEI_HASH_SECRET", code === 1);

  const server = spawn("node", ["server.js"], { cwd: BACKEND, env });
  process.on("exit", () => server.kill());
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 60 && !log.includes("Server running"); i++) await new Promise((r) => setTimeout(r, 250));
  if (!log.includes("Server running")) { console.log(log); process.exit(1); }

  const mongoose = require(path.join(BACKEND, "node_modules/mongoose"));
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  const A = new Client(), B = new Client(), admin = new Client(), guest = new Client();
  await A.req("POST", "/api/auth/register", { name: "Ada Seller", email: "a@t.com", password: "password123" });
  await B.req("POST", "/api/auth/register", { name: "Bola Owner", email: "b@t.com", password: "password123" });
  await admin.req("POST", "/api/auth/register", { name: "Admin", email: "admin@t.com", password: "password123" });
  await db.collection("users").updateOne({ email: "admin@t.com" }, { $set: { userType: "admin" } });
  const bId = (await db.collection("users").findOne({ email: "b@t.com" }))._id;

  // TAC table
  let r = await admin.req("POST", "/api/admin/imei/tac", { tac: "49015420", brand: "Apple", model: "iPhone X" });
  t("admin adds TAC", r.status === 200 && r.json.data.device.model === "iPhone X", JSON.stringify(r.json));
  r = await A.req("POST", "/api/admin/imei/tac", { tac: "49015420", brand: "x", model: "y" });
  t("non-admin can't add TAC", r.status === 403);

  // Listing creation
  r = await A.req("POST", "/api/listings", listingBody({}));
  t("phone without IMEI → 400", r.status === 400 && /IMEI/.test(r.json.error), JSON.stringify(r.json));
  r = await A.req("POST", "/api/listings", listingBody({ imei: "490154203237519" }));
  t("bad check digit → 400", r.status === 400, JSON.stringify(r.json));
  r = await A.req("POST", "/api/listings", listingBody({ imei: "49-015420-323751-8", imeiVerified: false, imeiPhoto: `https://res.cloudinary.com/${CLOUD}/image/upload/imei.jpg` }));
  const l1 = r.json?.data?.listing;
  t("valid IMEI listing → 201", r.status === 201, JSON.stringify(r.json));
  t("server sets imeiVerified", l1?.imeiVerified === true);
  t("model match", l1?.imeiCheck?.modelMatch === "match", JSON.stringify(l1?.imeiCheck));
  t("last4 + tac returned", l1?.imeiLast4 === "7518" && l1?.imeiTac === "49015420");
  t("imeiHash NOT in create response", l1 && !("imeiHash" in l1));
  t("imeiPhoto kept", l1?.imeiPhoto?.endsWith("imei.jpg"));
  const stored = await db.collection("listings").findOne({ _id: new mongoose.Types.ObjectId(l1._id) });
  t("hash stored, raw IMEI not stored", stored.imeiHash?.length === 64 && !JSON.stringify(stored).includes("490154203237518"));

  r = await A.req("POST", "/api/listings", listingBody({ imei: "490154203237518" }));
  t("same seller duplicate → 409", r.status === 409 && /already have/.test(r.json.error), JSON.stringify(r.json));
  r = await B.req("POST", "/api/listings", listingBody({ imei: "490154203237518" }));
  t("other user duplicate → 409", r.status === 409 && /already listed/.test(r.json.error), JSON.stringify(r.json));

  // Admins and owners see the most of a listing, so they're the strictest check
  r = await admin.req("GET", "/api/listings?status=pending_review");
  t("listing feed hides imeiHash (even for admins)", r.status === 200 && r.json.data.listings.length > 0 && !JSON.stringify(r.json).includes("imeiHash"));
  r = await A.req("GET", `/api/listings/${l1._id}`);
  t("single listing hides imeiHash (even for its owner)", r.status === 200 && !("imeiHash" in r.json.data.listing));

  r = await A.req("POST", "/api/listings", listingBody({ imei: "353911101234566", deviceName: "Galaxy S21", subType: "android" }));
  const lUnknown = r.json?.data?.listing;
  t("unknown TAC listing allowed, flagged unknown", r.status === 201 && lUnknown.imeiCheck.modelMatch === "unknown", JSON.stringify(r.json));
  r = await A.req("POST", "/api/listings", listingBody({ imei: "490154209999996", deviceName: "iPhone 13 Pro" }));
  const lMismatch = r.json?.data?.listing;
  t("mismatched model allowed, flagged mismatch", r.status === 201 && lMismatch.imeiCheck.modelMatch === "mismatch" && lMismatch.imeiCheck.tacModel === "iPhone X", JSON.stringify(r.json));
  r = await A.req("POST", "/api/listings", listingBody({ deviceCategory: "laptop", subType: "macbook", deviceName: "MacBook Air" }));
  t("laptop without IMEI still allowed", r.status === 201, JSON.stringify(r.json));

  // Admin review checks + learning
  r = await admin.req("GET", `/api/admin/listings/${lMismatch._id}/review`);
  t("review flags imei_model_mismatch (high)", r.json?.data?.checks?.some((c) => c.code === "imei_model_mismatch" && c.severity === "high"), JSON.stringify(r.json?.data?.checks));
  r = await admin.req("GET", "/api/admin/imei/tac/unknown");
  t("unknown codes list has 35391110", r.json?.data?.codes?.some((c) => c.tac === "35391110"), JSON.stringify(r.json));
  r = await admin.req("GET", "/api/admin/imei/tac/mismatches");
  t("mismatch list has 49015420", r.json?.data?.codes?.some((c) => c.tac === "49015420" && c.deviceNames.includes("iPhone 13 Pro")), JSON.stringify(r.json));
  r = await admin.req("PATCH", `/api/admin/listings/${lUnknown._id}/approve`);
  t("approve unknown listing", r.status === 200, JSON.stringify(r.json));
  r = await admin.req("GET", "/api/admin/imei/tac?q=35391110");
  t("TAC learned on approval", r.json?.data?.devices?.[0]?.model === "Galaxy S21" && r.json.data.devices[0].source === "learned" && r.json.data.devices[0].brand === "Samsung", JSON.stringify(r.json));
  r = await admin.req("GET", "/api/admin/imei/tac/unknown");
  t("learned code leaves unknown list", !r.json?.data?.codes?.some((c) => c.tac === "35391110"));

  // CSV import doesn't overwrite manual
  r = await admin.req("POST", "/api/admin/imei/tac/import", { csv: "tac,brand,model\n49015420,Wrong,Overwrite\n35000011,Tecno,Spark 20\n123,Bad,Line" });
  t("CSV import: 1 added, manual kept, 1 problem", r.json?.data?.added === 1 && r.json.data.skippedManual === 1 && r.json.data.problems.length === 1, JSON.stringify(r.json));
  r = await admin.req("GET", "/api/admin/imei/tac?q=49015420");
  t("manual entry intact after import", r.json?.data?.devices?.[0]?.model === "iPhone X");

  // Public check
  r = await guest.req("POST", "/api/imei/check", { imei: "490154203237518", deviceName: "iPhone X" });
  t("guest check: valid, model, not stolen", r.status === 200 && r.json.data.device.model === "iPhone X" && r.json.data.modelMatch === "match" && r.json.data.reportedStolen === false, JSON.stringify(r.json));
  r = await guest.req("POST", "/api/imei/check", { imei: "123" });
  t("guest check invalid → 400", r.status === 400);

  // Stolen reports
  const police = `https://res.cloudinary.com/${CLOUD}/image/upload/police.pdf`;
  r = await B.req("POST", "/api/imei/stolen-reports", { imei: "350000112233446", brand: "Tecno", model: "Spark 20", policeStation: "Ikeja Division" });
  t("report without police file → 400", r.status === 400);
  r = await B.req("POST", "/api/imei/stolen-reports", { imei: "350000112233446", brand: "Tecno", model: "Spark 20", policeStation: "Ikeja Division", policeReportUrl: "https://evil.com/x.pdf" });
  t("report with foreign file URL → 400", r.status === 400);
  r = await B.req("POST", "/api/imei/stolen-reports", { imei: "350000112233446", brand: "Tecno", model: "Spark 20", policeStation: "Ikeja Division", policeReportUrl: police, incidentDate: "2026-10-01" });
  t("report stolen → 201 pending", r.status === 201 && r.json.data.report.status === "pending" && !("imeiHash" in r.json.data.report), JSON.stringify(r.json));
  r = await B.req("POST", "/api/imei/stolen-reports", { imei: "350000112233446", brand: "Tecno", model: "Spark 20", policeStation: "Ikeja", policeReportUrl: police });
  t("duplicate report → 409", r.status === 409);

  r = await A.req("POST", "/api/listings", listingBody({ imei: "350000112233446", deviceName: "Spark 20", subType: "android" }));
  t("listing a pending-reported IMEI → 409 stolen", r.status === 409 && /reported stolen/.test(r.json.error), JSON.stringify(r.json));
  let notes = await db.collection("notifications").find({ recipient: bId, type: "stolen_device_alert" }).toArray();
  t("owner alerted about listing attempt", notes.length === 1 && /tried to list/.test(notes[0].message), JSON.stringify(notes));
  r = await guest.req("POST", "/api/imei/check", { imei: "350000112233446" });
  t("guest check shows reportedStolen", r.json?.data?.reportedStolen === true && r.json.data.stolenReport.policeStation === "Ikeja Division", JSON.stringify(r.json));
  notes = await db.collection("notifications").find({ recipient: bId, type: "stolen_device_alert" }).toArray();
  t("second alert within the hour is throttled", notes.length === 1);
  const rep = await db.collection("stolenreports").findOne({ imeiLast4: "3446" });
  t("both hits logged (listing by A + guest check)", rep.hits.length === 2 && rep.hits[0].context === "listing" && rep.hits[1].context === "check");

  // Report A's live listing, admin confirms → listing removed
  r = await B.req("POST", "/api/imei/stolen-reports", { imei: "490154203237518", brand: "Apple", model: "iPhone X", policeStation: "Yaba Division", policeReportUrl: police });
  const rep2 = r.json?.data?.report;
  r = await admin.req("GET", "/api/admin/imei/stolen-reports?status=pending");
  t("admin sees 2 pending reports, no hash leaked", r.json?.data?.reports?.length === 2 && !JSON.stringify(r.json).includes("imeiHash"), JSON.stringify(r.json).slice(0, 300));
  r = await admin.req("PATCH", `/api/admin/imei/stolen-reports/${rep2.id}`, { status: "confirmed", reviewNotes: "Matches police extract" });
  t("confirm → 1 listing removed", r.status === 200 && r.json.data.listingsRemoved === 1 && !("imeiHash" in r.json.data.report), JSON.stringify(r.json));
  const l1After = await db.collection("listings").findOne({ _id: new mongoose.Types.ObjectId(l1._id) });
  t("A's listing now removed", l1After.status === "removed" && /stolen/.test(l1After.rejectionReason));
  notes = await db.collection("notifications").find({ recipient: bId, type: "stolen_report_update" }).toArray();
  t("reporter notified of confirmation", notes.length === 1);

  // Owner marks recovered → IMEI unblocked
  r = await B.req("PATCH", `/api/imei/stolen-reports/${rep2.id}/recovered`);
  t("owner marks recovered", r.status === 200 && r.json.data.report.status === "recovered");
  r = await A.req("PATCH", `/api/imei/stolen-reports/${rep2.id}/recovered`);
  t("someone else can't close the report", r.status === 404);
  r = await guest.req("POST", "/api/imei/check", { imei: "490154203237518" });
  t("recovered IMEI no longer flagged", r.json?.data?.reportedStolen === false);

  // PATCH paths
  r = await A.req("PATCH", `/api/listings/${lMismatch._id}`, { imei: "350000112233446" });
  t("PATCH to a stolen IMEI → 409", r.status === 409, JSON.stringify(r.json));
  r = await A.req("PATCH", `/api/listings/${lMismatch._id}`, { deviceName: "iPhone X" });
  t("PATCH deviceName re-compares model → match", r.status === 200 && r.json.data.listing.imeiCheck.modelMatch === "match" && !("imeiHash" in r.json.data.listing), JSON.stringify(r.json));
  r = await A.req("PATCH", `/api/listings/${lMismatch._id}`, { imeiVerified: false });
  const lm = await db.collection("listings").findOne({ _id: new mongoose.Types.ObjectId(lMismatch._id) });
  t("client can't unset/set imeiVerified", lm.imeiVerified === true);
  r = await A.req("PATCH", `/api/listings/${lMismatch._id}`, { imei: "490154201111111" });
  const lm2 = await db.collection("listings").findOne({ _id: new mongoose.Types.ObjectId(lMismatch._id) });
  t("PATCH new IMEI re-screens and stores new hash", r.status === 200 && lm2.imeiLast4 === "1111" && lm2.imeiHash !== lm.imeiHash, JSON.stringify(r.json));
  r = await A.req("PATCH", `/api/listings/${lMismatch._id}`, { imei: "490154201111111" });
  t("PATCH to the listing's own IMEI isn't a duplicate", r.status === 200, JSON.stringify(r.json));

  const aId = (await db.collection("users").findOne({ email: "a@t.com" }))._id;
  const legacy = await db.collection("listings").insertOne({ ...listingBody({}), owner: aId, imeiVerified: true, status: "active", bids: [], repairs: [], createdAt: new Date(), updatedAt: new Date() });
  r = await A.req("PATCH", `/api/listings/${legacy.insertedId}`, { description: "new text" });
  t("editing legacy phone listing requires IMEI", r.status === 400, JSON.stringify(r.json));
  r = await A.req("PATCH", `/api/listings/${legacy.insertedId}`, { status: "sold" });
  t("legacy listing can still be marked sold", r.status === 200 && r.json.data.listing.status === "sold", JSON.stringify(r.json));
  r = await admin.req("GET", `/api/admin/listings/${legacy.insertedId}/review`);
  t("legacy listing flagged imei_missing", r.json?.data?.checks?.some((c) => c.code === "imei_missing"));

  // Rate limit on public check (20 / 15 min; 4 used above)
  let last;
  for (let i = 0; i < 17; i++) last = await guest.req("POST", "/api/imei/check", { imei: "490154203237518" });
  t("public check rate-limited after 20", last.status === 429, String(last.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  server.kill();
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
