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

// ── Gap 4: sign out on every device ────────────────────────────────────────
section("sign out everywhere", async ({ db, Client, emails }) => {
  const login = async (email, password = "password123") => {
    const c = new Client();
    const r = await c.req("POST", "/api/auth/login", { email, password });
    return r.status === 200 ? c : null;
  };
  const reg = new Client();
  await reg.req("POST", "/api/auth/register", { name: "Sess Test", email: "sess@t.com", password: "password123" });
  await db.collection("users").updateOne({ email: "sess@t.com" }, { $set: { isVerified: true } });
  const phoneA = await login("sess@t.com");
  const phoneB = await login("sess@t.com");
  t("signed in on two devices", (await phoneA.req("GET", "/api/me")).status === 200 && (await phoneB.req("GET", "/api/me")).status === 200);
  let r = await phoneA.req("POST", "/api/auth/logout-all");
  t("log out everywhere → 200", r.status === 200, J(r.json));
  r = await phoneB.req("GET", "/api/me");
  t("other device is signed out", r.status === 401 && /signed out/.test(r.json.message), J(r.json));
  r = await phoneB.req("POST", "/api/auth/refresh");
  t("its refresh token no longer works either", r.status === 401);
  r = await phoneB.req("GET", "/api/listings");
  t("public pages still work for it (as a guest)", r.status === 200);
  const fresh = await login("sess@t.com");
  t("logging in again works", fresh && (await fresh.req("GET", "/api/me")).status === 200);

  // Password reset ends old sessions
  const before = emails().length;
  await new Client().req("POST", "/api/auth/forgot-password", { email: "sess@t.com" });
  await sleep(300);
  const link = emails().slice(before).find((e) => e.body.to[0].email === "sess@t.com")?.body.htmlContent.match(/token=([a-f0-9]+)/)?.[1];
  r = await new Client().req("POST", "/api/auth/reset-password", { token: link, password: "brandnew123" });
  t("password reset ok", r.status === 200, J(r.json));
  t("…and the old session is ended", (await fresh.req("GET", "/api/me")).status === 401);
  const afterReset = await login("sess@t.com", "brandnew123");

  // Admin force sign-out
  const id = (await db.collection("users").findOne({ email: "sess@t.com" }))._id;
  r = await ctx.C.admin.req("POST", `/api/admin/users/${id}/sign-out`);
  t("admin force sign-out", r.status === 200 && (await afterReset.req("GET", "/api/me")).status === 401, J(r.json));
  r = await ctx.C.buyer.req("POST", `/api/admin/users/${id}/sign-out`);
  t("only admins can force sign-out", r.status === 403);

  // Logins from before this change carry no session version — still valid
  const jwt = require(path.join(BACKEND, "node_modules/jsonwebtoken"));
  const other = (await db.collection("users").findOne({ email: "other@t.com" }))._id;
  const legacy = new Client();
  legacy.cookies.accessToken = jwt.sign({ id: String(other), userType: "user", vendorVerified: false }, ctx.env.JWT_SECRET, { expiresIn: "1h" });
  t("old-style token still works", (await legacy.req("GET", "/api/me")).status === 200);
});

// ── Gap 5: listings expire unless confirmed ────────────────────────────────
section("listing expiry", async ({ C, db, ids, Client }) => {
  const oid = (x) => new ctx.mongoose.Types.ObjectId(String(x));
  const tick = () => new Client().req("POST", "/api/internal/tick", null, { "X-Cron-Secret": "cron" });
  const mk = async (name) => {
    const r = await C.seller.req("POST", "/api/listings", { userName: "S", userPhone: "08031234567", deviceName: name, deviceCategory: "laptop", subType: "windows", estimatedMin: 1, estimatedMax: 2, images: [] });
    await C.admin.req("PATCH", `/api/admin/listings/${r.json.data.listing._id}/approve`);
    return r.json.data.listing._id;
  };
  const L = await mk("Dell Latitude");
  let l = await db.collection("listings").findOne({ _id: oid(L) });
  t("approval stamps lastConfirmedAt", l.lastConfirmedAt && Date.now() - l.lastConfirmedAt < 60000);
  const ago = (d) => new Date(Date.now() - d * 864e5);

  await db.collection("listings").updateOne({ _id: oid(L) }, { $set: { lastConfirmedAt: ago(15) } });
  let r = await tick();
  t("day 15: reminder sent", r.json.data.listingsReminded === 1 && (await db.collection("notifications").countDocuments({ recipient: ids.seller, title: "Is your Dell Latitude still available?" })) === 1, J(r.json));
  r = await tick();
  t("…only once", r.json.data.listingsReminded === 0);

  await db.collection("listings").updateOne({ _id: oid(L) }, { $set: { lastConfirmedAt: ago(31) } });
  const held = await mk("Held Laptop");
  await db.collection("listings").updateOne({ _id: oid(held) }, { $set: { lastConfirmedAt: ago(40), reservedUntil: new Date(Date.now() + 3600e3) } });
  r = await tick();
  l = await db.collection("listings").findOne({ _id: oid(L) });
  t("day 31: expired + seller told", l.status === "expired" && l.expiredAt && (await db.collection("notifications").countDocuments({ recipient: ids.seller, title: "Your listing has expired" })) === 1, J(r.json));
  t("listing held for a buyer is not expired", (await db.collection("listings").findOne({ _id: oid(held) })).status === "active");
  r = await new Client().req("GET", "/api/listings");
  t("expired listing leaves the marketplace", !r.json.data.listings.some((x) => x._id === L));
  r = await new Client().req("GET", `/api/listings/${L}`);
  t("…and its page", r.status === 404);
  r = await C.buyer.req("POST", `/api/listings/${L}/confirm`);
  t("only the seller can confirm", r.status === 404);
  r = await C.seller.req("POST", `/api/listings/${L}/confirm`);
  t("seller confirms → back on the marketplace", r.json?.data?.listing?.status === "active" && Date.now() - new Date(r.json.data.listing.lastConfirmedAt) < 60000, J(r.json));

  await db.collection("listings").updateOne({ _id: oid(L) }, { $set: { status: "expired", expiredAt: ago(61) } });
  r = await C.seller.req("POST", `/api/listings/${L}/confirm`);
  t("expired over 60 days → back through review", r.json.data.listing.status === "pending_review");

  await db.collection("listings").insertOne({ owner: ids.seller, userName: "S", userPhone: "x", deviceName: "Old Listing", deviceCategory: "laptop", subType: "windows", estimatedMin: 1, estimatedMax: 2, status: "active", bids: [], repairs: [], images: [], createdAt: ago(90), updatedAt: ago(90) });
  r = await tick();
  t("existing listings get a fresh 30 days (not expired on deploy)", r.json.data.listingsBackfilled === 1 && (await db.collection("listings").findOne({ deviceName: "Old Listing" })).status === "active", J(r.json));

  // Moderation bypass fix
  const R = await mk("Rejected Laptop");
  await C.admin.req("PATCH", `/api/admin/listings/${R}/reject`, { reason: "Stock photos" });
  r = await C.seller.req("PATCH", `/api/listings/${R}`, { status: "active" });
  t("seller can't switch a rejected listing to active (goes to review)", r.json.data.listing.status === "pending_review", J(r.json));
  const S = await mk("Stolen Laptop");
  await db.collection("listings").updateOne({ _id: oid(S) }, { $set: { status: "removed", rejectionReason: "This device has been reported stolen." } });
  r = await C.seller.req("PATCH", `/api/listings/${S}`, { status: "active" });
  t("…nor a listing removed as stolen", r.json.data.listing.status === "pending_review");
  const U = await mk("Sold By Mistake");
  await C.seller.req("PATCH", `/api/listings/${U}`, { status: "sold" });
  r = await C.seller.req("PATCH", `/api/listings/${U}`, { status: "active" });
  t("undoing 'sold' still works", r.json.data.listing.status === "active");
});

// ── Gap 6: ratings and reviews ─────────────────────────────────────────────
section("reviews", async ({ C, db, ids }) => {
  const oid = (x) => new ctx.mongoose.Types.ObjectId(String(x));
  let r = await C.buyer.req("GET", "/api/reviews/pending");
  const deals = r.json?.data?.deals || [];
  t("pending reviews list completed deals", deals.some((d) => d.type === "device_request" && d.subject.name === "Ade Phones") && deals.some((d) => d.type === "order_request" && d.subject.name === "Seller Test"), J(deals));
  const reqDeal = deals.find((d) => d.type === "device_request");
  r = await C.buyer.req("POST", "/api/reviews", { source: { type: "device_request", id: reqDeal.id }, rating: 6 });
  t("rating must be 1–5", r.status === 400);
  r = await C.other.req("POST", "/api/reviews", { source: { type: "device_request", id: reqDeal.id }, rating: 5 });
  t("someone outside the deal can't review it", r.status === 404);
  r = await C.buyer.req("POST", "/api/reviews", { source: { type: "device_request", id: reqDeal.id }, rating: 5, comment: "Fast and honest" });
  t("customer reviews the vendor", r.status === 201 && r.json.data.review.authorName === "Buyer", J(r.json));
  const reviewId = r.json.data.review.id;
  t("vendor told about the review", (await db.collection("notifications").countDocuments({ recipient: ids.v1, type: "review_received" })) === 1);
  r = await C.buyer.req("POST", "/api/reviews", { source: { type: "device_request", id: reqDeal.id }, rating: 1 });
  t("one review per deal", r.status === 409);
  const swap = await db.collection("transactions").findOne({ buyer: ids.buyer, type: "swap" });
  r = await C.buyer.req("POST", "/api/reviews", { source: { type: "transaction", id: String(swap._id) }, rating: 4 });
  t("can't review an unfinished deal", r.status === 409 && /completed/.test(r.json.message));
  const orderDeal = deals.find((d) => d.type === "order_request");
  await db.collection("orderrequests").updateOne({ _id: oid(orderDeal.id) }, { $set: { completedAt: new Date(Date.now() - 31 * 864e5) } });
  r = await C.buyer.req("POST", "/api/reviews", { source: { type: "order_request", id: orderDeal.id }, rating: 4 });
  t("reviews close after 30 days", r.status === 409 && /30 days/.test(r.json.message));
  await db.collection("orderrequests").updateOne({ _id: oid(orderDeal.id) }, { $set: { completedAt: new Date() } });
  r = await C.buyer.req("POST", "/api/reviews", { source: { type: "order_request", id: orderDeal.id }, rating: 4 });
  t("buyer reviews a listing's seller", r.status === 201);
  r = await C.buyer.req("GET", "/api/reviews/pending");
  t("reviewed deals leave the pending list", !r.json.data.deals.some((d) => [reqDeal.id, orderDeal.id].includes(d.id)));

  r = await new ctx.Client().req("GET", `/api/reviews/users/${ids.v1}`);
  t("public rating page", r.json.data.average === 5 && r.json.data.count === 1 && r.json.data.stars["5"] === 1 && r.json.data.reviews[0].comment === "Fast and honest" && !J(r.json).includes("buyer@t.com"), J(r.json));
  r = await C.buyer.req("POST", `/api/reviews/${reviewId}/reply`, { reply: "x" });
  t("only the reviewed person can reply", r.status === 404);
  r = await C.v1.req("POST", `/api/reviews/${reviewId}/reply`, { reply: "Thank you!" });
  t("vendor replies", r.status === 200 && r.json.data.review.reply === "Thank you!");
  r = await C.v1.req("POST", `/api/reviews/${reviewId}/reply`, { reply: "again" });
  t("…once", r.status === 409);

  r = await C.admin.req("PATCH", `/api/reviews/admin/${reviewId}`, { status: "hidden", reason: "test" });
  r = await new ctx.Client().req("GET", `/api/reviews/users/${ids.v1}`);
  t("hidden reviews don't count", r.json.data.count === 0 && r.json.data.average === null);
  await C.admin.req("PATCH", `/api/reviews/admin/${reviewId}`, { status: "visible" });
  r = await C.admin.req("GET", "/api/reviews/admin?maxRating=4");
  t("admin can list low ratings", r.json.data.reviews.length === 1 && r.json.data.reviews[0].rating === 4);

  r = await new ctx.Client().req("GET", "/api/vendors/directory?state=Lagos");
  t("directory shows ratings", r.json.data.vendors.find((v) => v.name === "Ade Phones")?.rating?.average === 5, J(r.json.data.vendors));

  // Poorly rated vendors rank lower in matching; offers show ratings
  await db.collection("reviews").insertMany([1, 2, 3].map((i) => ({ author: oid(ids.other), authorName: "O", subject: oid(ids.v2), source: { type: "transaction", id: new ctx.mongoose.Types.ObjectId() }, rating: 1, status: "visible", createdAt: new Date(), updatedAt: new Date() })));
  r = await C.buyer.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "Galaxy A55", state: "Lagos" });
  const rq = await db.collection("devicerequests").findOne({ _id: oid(r.json.data.request.id) });
  t("well-rated vendor ranks first; low-rated still matched", String(rq.matchedVendors[0]) === String(ids.v1) && rq.matchedVendors.some((v) => String(v) === String(ids.v2)), J(rq.matchedVendors));
  await C.v2.req("POST", `/api/requests/${rq._id}/offers`, { price: 300000 });
  r = await C.buyer.req("GET", `/api/requests/${rq._id}`);
  t("offers show the vendor's rating", r.json.data.request.offers[0].vendorRating?.average === 1 && r.json.data.request.offers[0].vendorRating.count === 3, J(r.json.data.request.offers));
});

// ── Gap 7: disputes ────────────────────────────────────────────────────────
section("disputes", async ({ C, db, ids, Client }) => {
  const oid = (x) => new ctx.mongoose.Types.ObjectId(String(x));
  const sellViaWhatsApp = async (name) => {
    let r = await C.seller.req("POST", "/api/listings", { userName: "S", userPhone: "08031234567", deviceName: name, deviceCategory: "laptop", subType: "windows", estimatedMin: 190000, estimatedMax: 200000, images: [] });
    const L = r.json.data.listing._id;
    await C.admin.req("PATCH", `/api/admin/listings/${L}/approve`);
    r = await C.buyer.req("POST", "/api/order-requests", { buyerPhone: "08035550000", listingId: L });
    const o = r.json.data.request;
    await C.admin.req("PATCH", `/api/admin/order-requests/${o.id}`, { status: "in_progress" });
    await C.admin.req("PATCH", `/api/admin/order-requests/${o.id}`, { status: "completed" });
    return o.id;
  };
  const order = await sellViaWhatsApp("HP Envy x360");
  const src = { type: "order_request", id: order };
  let r = await C.buyer.req("POST", "/api/disputes", { source: src, reason: "broken", description: "The screen flickers badly" });
  t("unknown reason → 400", r.status === 400);
  r = await C.buyer.req("POST", "/api/disputes", { source: src, reason: "faulty", description: "bad" });
  t("needs a real description", r.status === 400);
  r = await C.other.req("POST", "/api/disputes", { source: src, reason: "faulty", description: "The screen flickers badly" });
  t("outsiders can't dispute someone else's deal", r.status === 404);
  r = await C.buyer.req("POST", "/api/disputes", { source: src, reason: "faulty", description: "The screen flickers badly after an hour", evidence: [`https://res.cloudinary.com/${CLOUD}/image/upload/flicker.jpg`, "https://evil.example/x.jpg"] });
  const D = r.json?.data?.dispute;
  t("buyer raises a dispute", r.status === 201 && /^DP-/.test(D.reference) && D.evidence.length === 1, J(r.json));
  t("seller payout frozen", (await db.collection("orderrequests").findOne({ _id: oid(order) })).payoutStatus === "on_hold");
  t("seller + admins notified", (await db.collection("notifications").countDocuments({ recipient: ids.seller, type: "dispute_update" })) === 1 && (await db.collection("notifications").countDocuments({ recipient: ids.admin, title: `New dispute ${D.reference}` })) === 1);
  r = await C.admin.req("GET", "/api/admin/finance");
  t("finance shows payouts on hold", r.json.data.outstanding.payoutsOnHold === 190000 && !r.json.data.outstanding.sellerPayouts.some((p) => p.id === order), J(r.json.data.outstanding));
  r = await C.buyer.req("POST", "/api/disputes", { source: src, reason: "faulty", description: "The screen flickers badly" });
  t("one open dispute per deal", r.status === 409);

  r = await C.other.req("GET", `/api/disputes/${D.id}`);
  t("outsiders can't read it", r.status === 404);
  r = await C.seller.req("GET", `/api/disputes/${D.id}`);
  t("seller sees it as respondent", r.json.data.dispute.yourRole === "respondent");
  r = await C.seller.req("POST", `/api/disputes/${D.id}/messages`, { text: "It worked perfectly when I handed it over." });
  t("seller replies; buyer notified", r.status === 201 && (await db.collection("notifications").countDocuments({ recipient: ids.buyer, type: "dispute_update" })) >= 1);
  r = await C.admin.req("POST", `/api/disputes/${D.id}/messages`, { text: "Please both send photos." });
  t("staff can post too", r.status === 201 && r.json.data.dispute.messages.map((m) => m.role).join() === "respondent,staff");
  r = await C.buyer.req("GET", "/api/disputes");
  t("listed for the buyer", r.json.data.disputes.some((d) => d.id === D.id && d.yourRole === "raiser"));

  r = await C.admin.req("PATCH", `/api/disputes/admin/${D.id}`, { status: "resolved" });
  t("resolved needs a resolution", r.status === 400);
  r = await C.admin.req("PATCH", `/api/disputes/admin/${D.id}`, { status: "investigating" });
  t("investigating", r.json.data.dispute.status === "investigating");
  r = await C.admin.req("PATCH", `/api/disputes/admin/${D.id}`, { status: "resolved", resolution: "refund", refundAmount: 200000, resolutionNote: "Screen fault confirmed at inspection." });
  t("resolved with refund → payout cancelled", r.status === 200 && (await db.collection("orderrequests").findOne({ _id: oid(order) })).payoutStatus === "cancelled", J(r.json));
  r = await C.buyer.req("POST", `/api/disputes/${D.id}/messages`, { text: "thanks" });
  t("closed disputes take no more messages", r.status === 409);
  r = await C.admin.req("PATCH", `/api/disputes/admin/${D.id}`, { status: "rejected" });
  t("can't decide twice", r.status === 409);

  const order2 = await sellViaWhatsApp("Lenovo ThinkPad T14");
  r = await C.buyer.req("POST", "/api/disputes", { source: { type: "order_request", id: order2 }, reason: "not_as_described", description: "Battery is weaker than listed" });
  await C.admin.req("PATCH", `/api/disputes/admin/${r.json.data.dispute.id}`, { status: "resolved", resolution: "repair" });
  t("non-refund outcome releases the payout", (await db.collection("orderrequests").findOne({ _id: oid(order2) })).payoutStatus === "pending");

  await db.collection("devicerequests").updateOne({ _id: oid(ctx.completedRequest) }, { $set: { completedAt: new Date(Date.now() - 8 * 864e5) } });
  r = await C.buyer.req("POST", "/api/disputes", { source: { type: "device_request", id: ctx.completedRequest }, reason: "faulty", description: "Stopped charging after a week" });
  t("disputes close 7 days after completion", r.status === 409 && /7 days/.test(r.json.message));
  r = await C.v1.req("POST", "/api/disputes", { source: { type: "device_request", id: ctx.completedRequest }, reason: "other", description: "Customer never paid the balance" });
  t("…for both sides", r.status === 409);
  r = await C.admin.req("GET", "/api/disputes/admin?status=resolved");
  t("admin list with counts", r.json.data.disputes.length === 2 && r.json.data.counts.resolved === 2);
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
