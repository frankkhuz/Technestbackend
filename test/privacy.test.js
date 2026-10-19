// End-to-end test of what the public can see: seller contacts hidden on
// the marketplace, blind vendor bids, admin-only statuses, paging, and
// CSRF on the vendor forms — against an in-memory MongoDB.
const path = require("path");
const { baseEnv } = require("./helpers/env");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server-core");

const BACKEND = path.resolve(__dirname, "..");
const PORT = 5106;
const CLOUD = "testcloud";
let pass = 0, fail = 0;
const t = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  ← " + String(extra).slice(0, 400)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

let ipSeq = 1;
class Client {
  constructor() { this.cookies = {}; this.ip = `10.2.0.${ipSeq++}`; }
  async req(method, url, body, { csrf = true } = {}) {
    const h = { "Content-Type": "application/json", "X-Forwarded-For": this.ip };
    const c = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (c) h.Cookie = c;
    if (csrf && this.cookies.csrfToken) h["X-CSRF-Token"] = this.cookies.csrfToken;
    const res = await fetch(`http://localhost:${PORT}${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";"); const i = kv.indexOf("=");
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json };
  }
}

(async () => {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri("technest_test");
  const env = {
    ...baseEnv(), PORT, MONGO_URI: uri, NODE_ENV: "development",
    JWT_SECRET: "j".repeat(40), JWT_REFRESH_SECRET: "r".repeat(40),
    CLOUDINARY_CLOUD_NAME: CLOUD, CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
    IMEI_HASH_SECRET: "h".repeat(40), PAYSTACK_SECRET_KEY: "", ANTHROPIC_API_KEY: "",
    EMAIL_PROVIDER: "", EMAIL_API_KEY: "", EMAIL_FROM: "",
  };
  const server = spawn("node", ["server.js"], { cwd: BACKEND, env });
  process.on("exit", () => server.kill());
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 80 && !log.includes("Server running"); i++) await sleep(250);
  if (!log.includes("Server running")) { console.log(log); process.exit(1); }

  const mongoose = require(path.join(BACKEND, "node_modules/mongoose"));
  await mongoose.connect(uri);
  const users = mongoose.connection.db.collection("users");
  const listings = mongoose.connection.db.collection("listings");

  const C = {};
  for (const n of ["admin", "seller", "v1", "v2"]) {
    C[n] = new Client();
    await C[n].req("POST", "/api/auth/register", { name: `${n} Test`, email: `${n}@t.com`, password: "password123" });
  }
  const guest = new Client();
  await users.updateOne({ email: "admin@t.com" }, { $set: { userType: "admin" } });
  await users.updateMany({ email: { $in: ["v1@t.com", "v2@t.com"] } }, {
    $set: { userType: "vendor", vendorVerified: true, vendorProfile: { phone: "+2348030000001", businessRegNumber: "RC1", shopAddress: "Secret address 1", businessName: "Shop" } },
  });
  await users.updateOne({ email: "seller@t.com" }, {
    $set: { vendorProfile: { phone: "+2348030000009", shopAddress: "Seller's home address" } },
  });

  const make = (name) =>
    C.seller.req("POST", "/api/listings", {
      userName: "Seller Person", userPhone: "0803 555 0000", deviceName: name, deviceCategory: "laptop", subType: "windows",
      estimatedMin: 100000, estimatedMax: 120000, images: [`https://res.cloudinary.com/${CLOUD}/image/upload/a.jpg`],
    });
  let r = await make("Dell XPS 13");
  const L = r.json.data.listing._id;

  // In review: only owner + admin
  r = await guest.req("GET", "/api/listings?status=pending_review");
  t("guest can't browse listings in review", r.status === 403);
  r = await C.v1.req("GET", "/api/listings?status=rejected");
  t("vendor can't browse rejected listings", r.status === 403);
  r = await C.admin.req("GET", "/api/listings?status=pending_review");
  t("admin can", r.status === 200 && r.json.data.listings.length === 1);
  r = await guest.req("GET", `/api/listings/${L}`);
  t("guest can't open a listing in review", r.status === 404);
  r = await C.seller.req("GET", `/api/listings/${L}`);
  t("owner can, with their own phone", r.status === 200 && r.json.data.listing.userPhone === "+2348035550000");

  await C.admin.req("PATCH", `/api/admin/listings/${L}/approve`);
  await listings.updateOne({ _id: new mongoose.Types.ObjectId(L) }, { $set: { aiReview: { summary: "Looks risky", recommendation: "check" } } });
  await C.v1.req("POST", "/api/vendor/bid", { listingId: L, amount: 100000 });
  await C.v2.req("POST", "/api/vendor/bid", { listingId: L, amount: 110000 });

  // Public view
  r = await guest.req("GET", `/api/listings/${L}`);
  const pub = r.json.data.listing;
  const raw = J(pub);
  t("public listing: no seller phone, email, address or admin notes", !("userPhone" in pub) && !raw.includes("seller@t.com") && !raw.includes("+2348030000009") && !raw.includes("home address") && !("aiReview" in pub) && !raw.includes("imeiHash"), raw);
  t("public listing keeps what buyers need", pub.owner.name === "seller Test" && pub.deviceName === "Dell XPS 13" && pub.isAvailable === true && "identityVerified" in pub.owner);
  t("guest sees bid count, not bids", pub.bidCount === 2 && pub.bids.length === 0, J(pub.bids));
  r = await C.v1.req("GET", `/api/listings/${L}`);
  t("vendor sees only their own bid", r.json.data.listing.bids.length === 1 && r.json.data.listing.bids[0].amount === 100000 && r.json.data.listing.bidCount === 2);
  r = await C.seller.req("GET", `/api/listings/${L}`);
  t("owner sees every bid + full details", r.json.data.listing.bids.length === 2 && r.json.data.listing.userPhone);
  r = await C.admin.req("GET", `/api/listings/${L}`);
  t("admin sees everything", r.json.data.listing.bids.length === 2 && r.json.data.listing.aiReview?.summary === "Looks risky");
  r = await guest.req("GET", "/api/listings");
  t("feed is public-safe too", r.json.data.listings.length === 1 && !J(r.json).includes("+234") && !J(r.json).includes("@t.com"), J(r.json).slice(0, 300));

  // Paging
  for (const n of ["HP Envy", "Lenovo Yoga", "Asus Zenbook"]) {
    const x = await make(n);
    await C.admin.req("PATCH", `/api/admin/listings/${x.json.data.listing._id}/approve`);
  }
  r = await guest.req("GET", "/api/listings?limit=3");
  t("paging: first page", r.json.data.listings.length === 3 && r.json.data.total === 4 && r.json.data.pages === 2 && r.json.data.page === 1, J({ ...r.json.data, listings: r.json.data.listings.length }));
  r = await guest.req("GET", "/api/listings?limit=3&page=2");
  t("paging: second page", r.json.data.listings.length === 1);
  r = await guest.req("GET", "/api/listings?status=sold");
  t("sold listings are public", r.status === 200);

  // CSRF on vendor forms
  r = await C.v1.req("PATCH", "/api/vendor/verify", { phone: "08031112222", businessRegNumber: "RC1", shopAddress: "x" }, { csrf: false });
  t("vendor application without CSRF header → 403", r.status === 403);
  r = await C.seller.req("PATCH", "/api/vendor/upgrade", null, { csrf: false });
  t("vendor upgrade without CSRF header → 403", r.status === 403);
  r = await C.seller.req("PATCH", "/api/vendor/upgrade");
  t("vendor upgrade with CSRF header works", r.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect(); await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
