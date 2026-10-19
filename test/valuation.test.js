// End-to-end test of device valuation: unchanged results for old inputs,
// cosmetic grade, faults priced from the repair list, Snapchat, locked
// devices, confidence, IMEI model warnings, swaps, and the admin accuracy
// report — against an in-memory MongoDB.
const path = require("path");
const { baseEnv } = require("./helpers/env");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server-core");

const BACKEND = path.resolve(__dirname, "..");
const PORT = 5107;
const REPAIRS = new Map(require("../data/repairs.json").map((r) => [r.id, r]));
let pass = 0, fail = 0;
const t = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  ← " + String(extra).slice(0, 400)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
// Same scaling as utils/valuation.js, written out independently
const repairCost = (id, base) => {
  const r = REPAIRS.get(id);
  const pos = Math.min(1, Math.max(0, (base - 100000) / 1400000));
  return Math.round((r.priceMin + (r.priceMax - r.priceMin) * pos) / 500) * 500;
};

let ipSeq = 1;
class Client {
  constructor() { this.cookies = {}; this.ip = `10.3.0.${ipSeq++}`; }
  async req(method, url, body) {
    const h = { "Content-Type": "application/json", "X-Forwarded-For": this.ip };
    const c = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (c) h.Cookie = c;
    if (this.cookies.csrfToken) h["X-CSRF-Token"] = this.cookies.csrfToken;
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
    CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
    IMEI_HASH_SECRET: "h".repeat(40),
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
  const db = mongoose.connection.db;
  const guest = new Client();
  const est = (body) => guest.req("POST", "/api/valuation/estimate", body);

  const iphone = { category: "phone", subType: "iphone", deviceId: "iphone-16-pro-max-256" };
  const BASE = (await db.collection("valuationdevices").findOne({ deviceId: iphone.deviceId })).baseMax;

  let r = await guest.req("GET", "/api/valuation/conditions");
  const faultIds = r.json?.data?.faults?.map((f) => f.id) || [];
  t("conditions list: faults with appliesTo + cosmetic grades", faultIds.includes("screen_cracked") && r.json.data.faults.find((f) => f.id === "keyboard_fault").appliesTo.join() === "laptop" && r.json.data.cosmeticGrades.length === 4, J(r.json));

  // Old inputs → same numbers as before (±3% around base × (1 − deductions))
  r = await est({ ...iphone, batteryHealth: 100 });
  let v = r.json?.data?.valuation;
  t("clean device: same min/max/value as before", v.min === Math.round(BASE * 0.97) && v.max === Math.round(BASE * 1.03) && v.value === Math.round((v.min + v.max) / 2), J(v));
  r = await est({ ...iphone, batteryHealth: 82, screenChanged: true });
  v = r.json.data.valuation;
  t("old deductions unchanged (battery 80–84% + screen replaced = 24%)", v.deductionPercent === 24 && v.min === Math.round(Math.round(BASE * 0.76) * 0.97), J(v));
  t("each line has a naira amount", v.breakdown.every((b) => typeof b.amount === "number") && v.breakdown.find((b) => /Screen replaced/.test(b.label)).amount === Math.round(BASE * -0.12), J(v.breakdown));

  // New: cosmetic, Snapchat, faults
  r = await est({ ...iphone, cosmeticGrade: "fair", snapchatStatus: "banned" });
  v = r.json.data.valuation;
  t("cosmetic 'fair' (−10%) + Snapchat banned (−10%)", v.deductionPercent === 20 && v.breakdown.some((b) => /Snapchat/.test(b.label)), J(v));
  const screen = repairCost("screen-replacement-oem", BASE);
  const port = repairCost("charging-port-repair", BASE);
  r = await est({ ...iphone, faults: ["screen_cracked", "charging_port", "keyboard_fault", "made_up"] });
  v = r.json.data.valuation;
  const expected = Math.round(BASE) - screen - port;
  t("fixable faults priced from the repair list; laptop-only + unknown faults ignored", v.repairDeduction === screen + port && v.min === Math.round(expected * 0.97) && v.breakdown.filter((b) => b.amount < 0).length === 2 && v.breakdown.some((b) => b.label.includes(`₦${screen.toLocaleString()}`)), J({ v, screen, port }));
  r = await est({ category: "phone", subType: "android", deviceId: "other-android", customDevicePrice: 150000, faults: ["screen_cracked"] });
  v = r.json.data.valuation;
  t("cheap phone uses the budget screen price", v.repairDeduction === repairCost("screen-replacement-budget", 150000), J(v));
  r = await est({ ...iphone, faults: ["water_damage", "network_fault"] });
  t("unfixable faults are percentages", r.json.data.valuation.deductionPercent === 55);
  // ₦100k phone: 65% cap leaves ₦35k, repairs cost more → the 15% floor holds
  r = await est({ category: "phone", subType: "android", deviceId: "other-android", customDevicePrice: 100000, batteryHealth: 50, screenChanged: true, faceIdStatus: "broken", simType: "locked", cosmeticGrade: "poor", faults: ["screen_cracked", "back_cracked", "camera_fault", "charging_port", "speaker_mic", "buttons", "water_damage"] });
  v = r.json.data.valuation;
  t("never below 15% of base (parts value); cap flagged", v.min === Math.round(15000 * 0.97) && v.deductionCapped === true, J(v));
  r = await est({ category: "laptop", subType: "macbook", deviceId: "mbp-m3-2tb", snapchatStatus: "banned", batteryCycleCount: 1200, faults: ["keyboard_fault", "network_fault"] });
  v = r.json.data.valuation;
  t("laptops: no Snapchat/network deductions, cycles + keyboard count", v.deductionPercent === 8 && v.repairDeduction > 0 && !v.breakdown.some((b) => /Snapchat|network/i.test(b.label)), J(v));

  // Locked + confidence + IMEI
  r = await est({ ...iphone, accountLocked: true });
  t("account-locked device refused", r.status === 400 && /iCloud or Google/.test(r.json.message));
  r = await est({ ...iphone });
  t("confidence + likely range on catalogue device", ["high", "medium"].includes(r.json.data.valuation.confidence.level) && r.json.data.valuation.likelyRange.min <= r.json.data.valuation.min);
  r = await est({ category: "phone", subType: "android", deviceId: "other-android", customDevicePrice: 200000 });
  v = r.json.data.valuation;
  t("custom price → low confidence, wider likely range, same min/max", v.confidence.level === "low" && v.likelyRange.min === Math.round(200000 * 0.92) && v.min === Math.round(200000 * 0.97), J(v));
  await db.collection("tacdevices").insertOne({ tac: "35391110", brand: "Samsung", model: "Galaxy S21", active: true, source: "manual" });
  r = await est({ ...iphone, imei: "353911101234566" });
  t("IMEI of a different model → warning", r.json.data.valuation.warnings.some((w) => /Samsung Galaxy S21, not a iPhone 16 Pro Max/.test(w)), J(r.json.data.valuation.warnings));
  r = await est({ ...iphone, imei: "123" });
  t("bad IMEI → warning, still valued", r.status === 200 && /IMEI doesn't look right/.test(r.json.data.valuation.warnings[0]));

  // Swaps: locked refused, faults stored and priced
  const C = {};
  for (const n of ["admin", "seller", "buyer"]) {
    C[n] = new Client();
    await C[n].req("POST", "/api/auth/register", { name: `${n} Test`, email: `${n}@t.com`, password: "password123" });
  }
  await db.collection("users").updateOne({ email: "admin@t.com" }, { $set: { userType: "admin" } });
  r = await C.seller.req("POST", "/api/listings", { userName: "S", userPhone: "08031234567", deviceName: "MacBook Air M2", deviceCategory: "laptop", subType: "macbook", estimatedMin: 900000, estimatedMax: 1000000, images: [] });
  const L = r.json.data.listing._id;
  await C.admin.req("PATCH", `/api/admin/listings/${L}/approve`);
  r = await C.buyer.req("POST", "/api/transactions/swap-quote", { listingId: L, offeredDevice: { ...iphone, accountLocked: true } });
  t("swap with a locked device refused", r.status === 400 && /iCloud or Google/.test(r.json.message), J(r.json));
  r = await C.buyer.req("POST", "/api/transactions", { type: "swap", listingId: L, offeredDevice: { ...iphone, imei: "490154203237518", faults: ["screen_cracked"], cosmeticGrade: "good" } });
  const sd = r.json?.data?.transaction?.swapDetails;
  t("swap stores faults + grade and prices them", r.status === 201 && J(sd.offeredCondition.faults) === '["screen_cracked"]' && sd.offeredCondition.cosmeticGrade === "good" && sd.offeredValuation === Math.round(((Math.round(BASE * 0.96) - screen) * 0.97 + (Math.round(BASE * 0.96) - screen) * 1.03) / 2), J(sd));

  // Accuracy report: 3 deals ~20% under estimate on one device
  const owner = (await db.collection("users").findOne({ email: "seller@t.com" }))._id;
  const buyer = (await db.collection("users").findOne({ email: "buyer@t.com" }))._id;
  for (const [i, agreed] of [800000, 790000, 810000].entries()) {
    const id = new mongoose.Types.ObjectId();
    await db.collection("listings").insertOne({
      _id: id, owner, userName: "S", userPhone: "x", deviceName: "iPhone 16 Pro Max", storage: "256GB", deviceCategory: "phone", subType: "iphone",
      estimatedMin: 980000, estimatedMax: 1020000, status: "sold", createdAt: new Date(), updatedAt: new Date(), repairs: [], images: [],
      bids: [{ _id: new mongoose.Types.ObjectId(), vendor: buyer, vendorName: "V", amount: agreed - 20000 }],
    });
    await db.collection("transactions").insertOne({ type: "sell", listing: id, listingDeviceName: "iPhone 16 Pro Max", seller: owner, sellerName: "S", buyer, buyerName: "V", agreedPrice: agreed, status: i ? "completed" : "accepted", createdAt: new Date(), updatedAt: new Date() });
  }
  r = await C.admin.req("GET", "/api/admin/prices/accuracy");
  const dev = r.json?.data?.devices?.find((d) => d.deviceId === "iphone-16-pro-max-256");
  t("accuracy report: deals ~20% under estimate flagged", dev && dev.deals === 3 && dev.dealRatio === 0.8 && /20% under/.test(dev.suggestion) && r.json.data.overall.deals === 3, J(r.json?.data));
  t("offers counted too", dev?.offers === 3 && dev.offerRatio === 0.78, J(dev));
  r = await C.buyer.req("GET", "/api/admin/prices/accuracy");
  t("accuracy report is admin-only", r.status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect(); await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
