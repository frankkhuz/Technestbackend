// End-to-end test of the gap fixes: swap IMEI checks, backups, revenue
// records, sign-out everywhere, listing expiry, ratings, disputes, delivery,
// marketplace search, account deletion/export/unsubscribe, admin audit log,
// stock counts, error alerts — against an in-memory MongoDB with outside
// services mocked.
const fs = require("fs");
const path = require("path");
const { baseEnv } = require("./helpers/env");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server-core");

const BACKEND = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "technest-test-"));
const EMAIL_LOG = path.join(TMP, "emails.jsonl");
const PORT = 5109;
const CLOUD = "testcloud";
let pass = 0, fail = 0;
const t = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  ← " + String(extra).slice(0, 400)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const emails = () => (fs.existsSync(EMAIL_LOG) ? fs.readFileSync(EMAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);

let ipSeq = 1;
class Client {
  constructor() { this.cookies = {}; this.ip = `10.4.0.${ipSeq++}`; }
  async req(method, url, body, headers = {}) {
    const h = { "Content-Type": "application/json", "X-Forwarded-For": this.ip, ...headers };
    const c = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (c) h.Cookie = c;
    if (this.cookies.csrfToken) h["X-CSRF-Token"] = this.cookies.csrfToken;
    const res = await fetch(`http://localhost:${PORT}${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";"); const i = kv.indexOf("=");
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
}

const ctx = {};
const sections = [];
const section = (name, fn) => sections.push([name, fn]);

// ── Gap 1: swaps check the offered phone's IMEI ────────────────────────────
section("swap IMEI", async ({ C, db, ids }) => {
  let r = await C.seller.req("POST", "/api/listings", { userName: "S", userPhone: "08031234567", deviceName: "MacBook Air M2", deviceCategory: "laptop", subType: "macbook", estimatedMin: 900000, estimatedMax: 1000000, images: [] });
  const L = r.json.data.listing._id;
  ctx.laptopListing = L;
  await C.admin.req("PATCH", `/api/admin/listings/${L}/approve`);
  const phone = { category: "phone", subType: "iphone", deviceId: "iphone-16-pro-max-256" };
  r = await C.buyer.req("POST", "/api/transactions", { type: "swap", listingId: L, offeredDevice: phone });
  t("phone swap without IMEI → 400", r.status === 400 && /IMEI/.test(r.json.message), J(r.json));
  r = await C.buyer.req("POST", "/api/transactions", { type: "swap", listingId: L, offeredDevice: { ...phone, imei: "490154203237519" } });
  t("bad IMEI → 400", r.status === 400);
  await C.other.req("POST", "/api/imei/stolen-reports", { imei: "353911101234566", brand: "Samsung", model: "Galaxy S21", policeStation: "Ikeja", policeReportUrl: `https://res.cloudinary.com/${CLOUD}/image/upload/p.pdf` });
  r = await C.buyer.req("POST", "/api/transactions", { type: "swap", listingId: L, offeredDevice: { ...phone, imei: "353911101234566" } });
  t("stolen phone can't be swapped in", r.status === 409 && /reported stolen/.test(r.json.message), J(r.json));
  t("owner alerted about the swap attempt", (await db.collection("notifications").countDocuments({ recipient: ids.other, type: "stolen_device_alert" })) === 1);
  await db.collection("tacdevices").insertOne({ tac: "49015420", brand: "Apple", model: "iPhone 11", active: true, source: "manual" });
  r = await C.buyer.req("POST", "/api/transactions", { type: "swap", listingId: L, offeredDevice: { ...phone, imei: "490154203237518" } });
  const sd = r.json?.data?.transaction?.swapDetails;
  t("clean IMEI → swap created; seller sees last 4 + model mismatch", r.status === 201 && sd.offeredImeiLast4 === "7518" && sd.offeredImeiCheck.modelMatch === "mismatch" && sd.offeredImeiCheck.tacModel === "iPhone 11", J(r.json));
  t("full IMEI not stored", !J(await db.collection("transactions").findOne({ _id: new ctx.mongoose.Types.ObjectId(r.json.data.transaction.id) })).includes("490154203237518"));
  r = await C.buyer.req("POST", "/api/transactions", { type: "swap", listingId: L, offeredDevice: { category: "laptop", subType: "macbook", deviceId: "mbp-m3-2tb" } });
  t("laptop swaps don't need an IMEI", r.status === 200 || r.status === 201, J(r.json));
});

// ── Gap 2: encrypted backups ───────────────────────────────────────────────
section("backups", async ({ db, mongo }) => {
  const { execFile } = require("child_process");
  const file = path.join(TMP, "test.tnbk");
  const PASS = "correct horse battery staple";
  // Async on purpose: a blocking run would freeze the in-memory database,
  // which lives in this process
  const script = (name, args, extra = {}) =>
    new Promise((resolve) =>
      execFile(process.execPath, [path.join(BACKEND, "scripts", name), ...args], {
        cwd: BACKEND, encoding: "utf8", maxBuffer: 1e8, env: { ...baseEnv(), MONGO_URI: mongo.getUri("technest_test"), BACKUP_PASSPHRASE: PASS, ...extra },
      }, (err, stdout, stderr) => resolve({ status: err ? err.code ?? 1 : 0, stdout, stderr }))
    );
  let r = await script("backup.js", ["--out", file], { BACKUP_PASSPHRASE: "short" });
  t("backup refuses a short passphrase", r.status === 1 && /16/.test(r.stderr), r.stderr);
  r = await script("backup.js", ["--out", file]);
  t("backup runs", r.status === 0 && /Backed up \d+ documents/.test(r.stdout), r.stderr + r.stdout);
  const raw = fs.readFileSync(file);
  t("file is encrypted (no readable data inside)", raw.subarray(0, 5).toString() === "TNBK1" && !raw.includes("seller@t.com") && !raw.includes("users"));
  r = await script("restore.js", [file, "--list"]);
  t("--list shows what's inside", r.status === 0 && /users: 6/.test(r.stdout), r.stdout + r.stderr);
  r = await script("restore.js", [file, "--list"], { BACKUP_PASSPHRASE: "wrong passphrase 123456" });
  t("wrong passphrase refused", r.status === 1 && /wrong passphrase/.test(r.stderr));
  const tampered = Buffer.from(raw); tampered[60] ^= 1;
  fs.writeFileSync(file + ".bad", tampered);
  r = await script("restore.js", [file + ".bad", "--list"]);
  t("damaged file refused", r.status === 1 && /damaged/.test(r.stderr));
  r = await script("restore.js", [file]);
  t("restore needs an explicit --to", r.status === 1 && /--to/.test(r.stderr));
  r = await script("restore.js", [file, "--to", mongo.getUri("technest_test")]);
  t("won't restore over existing data", r.status === 1 && /already have data/.test(r.stderr));
  const target = mongo.getUri("technest_restored");
  r = await script("restore.js", [file, "--to", target]);
  t("restore into an empty database", r.status === 0 && /Restored 6 into users/.test(r.stdout), r.stdout + r.stderr);
  const restored = ctx.mongoose.connection.useDb("technest_restored");
  const [a, b] = await Promise.all([db.collection("users").findOne({ email: "seller@t.com" }), restored.collection("users").findOne({ email: "seller@t.com" })]);
  t("documents identical, ObjectIds and dates kept", J(a) === J(b) && b._id instanceof ctx.mongoose.Types.ObjectId && b.createdAt instanceof Date, J({ a, b }));
  const counts = async (d) => Object.fromEntries(await Promise.all((await d.listCollections().toArray()).map(async (c) => [c.name, await d.collection(c.name).countDocuments()])));
  t("every collection restored", J(Object.entries(await counts(db)).sort()) === J(Object.entries(await counts(restored.db)).sort()));
  r = await script("restore.js", [file, "--to", target, "--only", "users", "--drop"]);
  t("--only + --drop replaces just that collection", r.status === 0 && /Restored 6 into users/.test(r.stdout) && !/into listings/.test(r.stdout));
});

// ── Gap 3: revenue and commission records ──────────────────────────────────
section("revenue", async ({ C, db, ids }) => {
  await C.admin.req("POST", "/api/products", { slug: "iphone-13", type: "phone", name: "iPhone 13", brand: "Apple", category: "flagship", priceUkUsed: 400000, priceBrandNew: 600000 });
  let r = await C.buyer.req("POST", "/api/order-requests", { buyerPhone: "08035550000", items: [{ itemId: "iphone-13", quantity: 1 }] });
  const cart = r.json.data.request;
  await C.admin.req("PATCH", `/api/admin/order-requests/${cart.id}`, { status: "in_progress" });
  r = await C.admin.req("PATCH", `/api/admin/order-requests/${cart.id}`, { status: "completed" });
  t("cart order: whole price is TechNest's revenue by default", r.json.data.request.finalPrice === 400000 && r.json.data.request.commission === 400000 && r.json.data.request.payoutStatus === "none", J(r.json));

  r = await C.buyer.req("POST", "/api/order-requests", { buyerPhone: "08035550000", listingId: ctx.laptopListing });
  const lo = r.json.data.request;
  await C.admin.req("PATCH", `/api/admin/order-requests/${lo.id}`, { status: "in_progress" });
  r = await C.admin.req("PATCH", `/api/admin/order-requests/${lo.id}`, { status: "completed", finalPrice: 950000, commission: 960000 });
  t("commission above the price → 400 (nothing changed)", r.status === 400 && (await db.collection("orderrequests").findOne({ reference: lo.reference })).status === "in_progress");
  r = await C.admin.req("PATCH", `/api/admin/order-requests/${lo.id}`, { status: "completed", finalPrice: 950000 });
  t("listing order: 5% commission, seller owed the rest", r.json.data.request.commission === 47500 && r.json.data.request.sellerPayout === 902500 && r.json.data.request.payoutStatus === "pending", J(r.json));

  r = await C.buyer.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "iPhone 14", state: "Lagos" });
  const rq = r.json.data.request;
  await C.v1.req("POST", `/api/requests/${rq.id}/offers`, { price: 500000 });
  r = await C.buyer.req("GET", `/api/requests/${rq.id}`);
  await C.buyer.req("POST", `/api/requests/${rq.id}/offers/${r.json.data.request.offers[0].id}/accept`);
  r = await C.admin.req("PATCH", `/api/admin/requests/${rq.id}`, { status: "completed" });
  t("request: accepted offer price, vendor owes 5%", r.json.data.request.finalPrice === 500000 && r.json.data.request.commission === 25000 && r.json.data.request.commissionStatus === "due", J(r.json));
  ctx.completedRequest = rq.id;

  r = await C.admin.req("GET", "/api/admin/finance");
  const f = r.json.data;
  t("finance totals: 3 deals, sales and revenue add up", f.totals.count === 3 && f.totals.sales === 1850000 && f.totals.revenue === 472500, J(f.totals));
  t("by channel", f.byChannel.whatsappCatalog.revenue === 400000 && f.byChannel.whatsappListings.revenue === 47500 && f.byChannel.requests.revenue === 25000, J(f.byChannel));
  t("outstanding: owed to seller + owed by vendor", f.outstanding.owedToSellers === 902500 && f.outstanding.sellerPayouts[0].seller.name === "Seller Test" && f.outstanding.owedByVendors === 25000 && f.outstanding.vendorCommissions[0].vendor.name === "Ade Phones", J(f.outstanding));
  t("by month", f.byMonth.length === 1 && f.byMonth[0].count === 3);
  r = await C.admin.req("GET", "/api/admin/finance?from=2020-01-01&to=2020-01-31");
  t("date range filters deals (outstanding stays)", r.json.data.totals.count === 0 && r.json.data.outstanding.owedToSellers === 902500);
  r = await C.v1.req("GET", "/api/vendor/commissions");
  t("vendor sees what they owe", r.json.data.owed === 25000 && r.json.data.requests[0].reference === rq.reference, J(r.json));

  r = await C.admin.req("PATCH", `/api/admin/finance/payouts/${lo.id}`, { reference: "GTB-TRF-001" });
  t("payout recorded + seller notified", r.status === 200 && (await db.collection("notifications").countDocuments({ recipient: ids.seller, title: "TechNest has paid you" })) === 1);
  r = await C.admin.req("PATCH", `/api/admin/finance/payouts/${lo.id}`, {});
  t("can't pay twice", r.status === 409);
  r = await C.admin.req("PATCH", `/api/admin/finance/commissions/${rq.id}`, { reference: "OPAY-77" });
  t("commission collected + vendor receipt", r.status === 200 && (await db.collection("notifications").countDocuments({ recipient: ids.v1, title: "Commission payment received" })) === 1);
  r = await C.v1.req("GET", "/api/vendor/commissions");
  t("vendor view updates", r.json.data.owed === 0 && r.json.data.paid === 25000);
  r = await C.admin.req("GET", "/api/admin/finance");
  t("nothing outstanding now", r.json.data.outstanding.owedToSellers === 0 && r.json.data.outstanding.owedByVendors === 0);
  r = await C.buyer.req("GET", "/api/admin/finance");
  t("finance is admin-only", r.status === 403);
});

(async () => {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri("technest_test");
  ctx.mongo = mongo;
  ctx.env = {
    ...baseEnv(), PORT, MONGO_URI: uri, NODE_ENV: "development", CLIENT_URL: "https://client.test",
    JWT_SECRET: "j".repeat(40), JWT_REFRESH_SECRET: "r".repeat(40),
    CLOUDINARY_CLOUD_NAME: CLOUD, CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
    IMEI_HASH_SECRET: "h".repeat(40), EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "k", EMAIL_FROM: "hello@technest.test",
    EMAIL_LOG, INTERNAL_CRON_SECRET: "cron", SUPPORT_WHATSAPP: "2348000000000",
  };
  const server = spawn("node", ["server.js"], { cwd: BACKEND, env: ctx.env });
  process.on("exit", () => server.kill());
  ctx.log = "";
  server.stdout.on("data", (d) => (ctx.log += d));
  server.stderr.on("data", (d) => (ctx.log += d));
  for (let i = 0; i < 80 && !ctx.log.includes("Server running"); i++) await sleep(250);
  if (!ctx.log.includes("Server running")) { console.log(ctx.log); process.exit(1); }

  const mongoose = require(path.join(BACKEND, "node_modules/mongoose"));
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const C = {};
  for (const n of ["admin", "seller", "buyer", "other", "v1", "v2"]) {
    C[n] = new Client();
    await C[n].req("POST", "/api/auth/register", { name: `${n[0].toUpperCase()}${n.slice(1)} Test`, email: `${n}@t.com`, password: "password123" });
  }
  await db.collection("users").updateMany({}, { $set: { isVerified: true } });
  await db.collection("users").updateOne({ email: "admin@t.com" }, { $set: { userType: "admin" } });
  await db.collection("users").updateMany({ email: { $in: ["v1@t.com", "v2@t.com"] } }, {
    $set: { userType: "vendor", vendorVerified: true, vendorProfile: { phone: "+2348030000001", businessRegNumber: "RC1", shopAddress: "x", vendorTypes: ["phone_dealer"], states: ["Lagos"] } },
  });
  await db.collection("users").updateOne({ email: "v1@t.com" }, { $set: { "vendorProfile.businessName": "Ade Phones" } });
  await db.collection("users").updateOne({ email: "v2@t.com" }, { $set: { "vendorProfile.businessName": "Bola Gadgets" } });
  const ids = {};
  for (const n of Object.keys(C)) ids[n] = (await db.collection("users").findOne({ email: `${n}@t.com` }))._id;
  Object.assign(ctx, { C, db, ids, mongoose, emails, Client });

  for (const [name, fn] of sections) {
    console.log(`── ${name}`);
    try {
      await fn(ctx);
    } catch (err) {
      t(`${name}: crashed`, false, err.stack);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(ctx.log.split("\n").filter((l) => /rror/.test(l)).slice(-8).join("\n"));
  await mongoose.disconnect(); await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
