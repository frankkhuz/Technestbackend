// End-to-end test of phone verification: manual (staff) and automatic
// (WhatsApp Cloud API webhook), against an in-memory MongoDB with Meta mocked.
const fs = require("fs");
const path = require("path");
const { baseEnv } = require("./helpers/env");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server-core");
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "technest-test-"));

const BACKEND = path.resolve(__dirname, "..");
const WA_LOG = path.join(TMP, "wa.jsonl");
const APP_SECRET = "meta-app-secret";
let pass = 0, fail = 0;
const t = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  ← " + String(extra).slice(0, 400)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
const waSent = () => (fs.existsSync(WA_LOG) ? fs.readFileSync(WA_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);

let ipSeq = 1;
class Client {
  constructor(port) { this.port = port; this.cookies = {}; this.ip = `10.1.0.${ipSeq++}`; }
  async req(method, url, body, headers = {}, raw = false) {
    const h = { "Content-Type": "application/json", "X-Forwarded-For": this.ip, ...headers };
    const c = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (c) h.Cookie = c;
    if (this.cookies.csrfToken) h["X-CSRF-Token"] = this.cookies.csrfToken;
    const res = await fetch(`http://localhost:${this.port}${url}`, { method, headers: h, body: raw ? body : body ? JSON.stringify(body) : undefined });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";"); const i = kv.indexOf("=");
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  }
}

const servers = [];
process.on("exit", () => servers.forEach((s) => s.kill()));
const start = async (port, uri, extra) => {
  const env = {
    ...baseEnv(), PORT: port, MONGO_URI: uri, NODE_ENV: "development", CLIENT_URL: "https://client.test",
    JWT_SECRET: "j".repeat(40), JWT_REFRESH_SECRET: "r".repeat(40),
    CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
    IMEI_HASH_SECRET: "h".repeat(40), PAYSTACK_SECRET_KEY: "", ANTHROPIC_API_KEY: "",
    EMAIL_PROVIDER: "", EMAIL_API_KEY: "", EMAIL_FROM: "", SUPPORT_WHATSAPP: "2348000000000",
    WHATSAPP_TOKEN: "", WHATSAPP_PHONE_NUMBER_ID: "", WHATSAPP_APP_SECRET: "", WHATSAPP_VERIFY_NUMBER: "", WHATSAPP_VERIFY_TOKEN: "",
    WA_LOG, EMAIL_LOG: path.join(TMP, "emails4.jsonl"),
    ...extra,
  };
  const s = spawn("node", ["server.js"], { cwd: BACKEND, env });
  servers.push(s);
  s.log = "";
  s.stdout.on("data", (d) => (s.log += d));
  s.stderr.on("data", (d) => (s.log += d));
  for (let i = 0; i < 80 && !s.log.includes("Server running"); i++) await sleep(250);
  if (!s.log.includes("Server running")) { console.log(s.log); process.exit(1); }
  return s;
};

const webhookBody = (from, text, id = `wamid.${crypto.randomUUID()}`) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: "PNID" }, messages: [{ from, id, timestamp: "1700000000", type: "text", text: { body: text } }] } }] }] });
const sign = (body, secret = APP_SECRET) => "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");

(async () => {
  if (fs.existsSync(WA_LOG)) fs.unlinkSync(WA_LOG);
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri("technest_test");
  const mongoose = require(path.join(BACKEND, "node_modules/mongoose"));
  await mongoose.connect(uri);
  const users = mongoose.connection.db.collection("users");
  const notes = mongoose.connection.db.collection("notifications");
  const user = (email) => users.findOne({ email });

  // ── Manual (no Cloud API) ─────────────────────────────────────────────
  let s1 = await start(5104, uri, {});
  t("startup says staff verify phones", /phone numbers are verified by staff/.test(s1.log));
  const P = 5104;
  const C = {};
  for (const n of ["admin", "ada", "bola", "chi"]) {
    C[n] = new Client(P);
    await C[n].req("POST", "/api/auth/register", { name: `${n} Test`, email: `${n}@t.com`, password: "password123" });
  }
  await users.updateOne({ email: "admin@t.com" }, { $set: { userType: "admin" } });

  let r = await C.ada.req("POST", "/api/phone/verify", { phone: "12345" });
  t("bad number → 400", r.status === 400);
  r = await C.ada.req("POST", "/api/phone/verify", { phone: "0803 123 4567" });
  const msg = decodeURIComponent(r.json?.data?.whatsappUrl?.split("text=")[1] || "");
  t("manual: link to sales number with email + number", r.status === 200 && r.json.data.method === "manual" && r.json.data.whatsappUrl.startsWith("https://wa.me/2348000000000?text=") && msg.includes("ada@t.com") && msg.includes("+2348031234567"), J(r.json));
  await C.ada.req("POST", "/api/phone/verify", { phone: "08031234567" });
  t("admins alerted once (not on repeat taps)", (await notes.countDocuments({ type: "admin_alert", title: "Phone number to verify" })) === 1);
  r = await C.ada.req("GET", "/api/phone");
  t("status shows pending manual check", r.json.data.phoneVerified === false && r.json.data.pending.method === "manual" && r.json.data.automatic === false, J(r.json));
  r = await C.admin.req("GET", "/api/admin/users?phonePending=true");
  t("admin sees waiting list", r.json.data.users.length === 1 && r.json.data.users[0].email === "ada@t.com");
  r = await C.admin.req("GET", "/api/admin/users?q=0803-123-4567");
  t("admin search by phone in any format", r.json.data.users.length === 1 && r.json.data.users[0].phoneVerification.phone === "+2348031234567", J(r.json));
  r = await C.ada.req("GET", "/api/admin/users");
  t("non-admin can't search users", r.status === 403);
  const adaId = (await user("ada@t.com"))._id;
  r = await C.admin.req("PATCH", `/api/admin/users/${adaId}/phone`, { verified: true });
  t("admin verifies the requested number", r.status === 200 && r.json.data.user.phoneVerified && r.json.data.user.phone === "+2348031234567" && r.json.data.user.phoneVerifiedVia === "admin", J(r.json));
  t("user notified", (await notes.countDocuments({ recipient: adaId, type: "account_update" })) === 1);
  r = await C.ada.req("GET", "/api/me");
  t("/api/me shows verified phone", r.json.data.phoneVerified === true && r.json.data.phone === "+2348031234567");
  r = await C.admin.req("GET", "/api/admin/users?phonePending=true");
  t("leaves the waiting list", r.json.data.users.length === 0);
  r = await C.bola.req("POST", "/api/phone/verify", { phone: "+2348031234567" });
  t("same number on another account → 409", r.status === 409);
  const bolaId = (await user("bola@t.com"))._id;
  r = await C.admin.req("PATCH", `/api/admin/users/${bolaId}/phone`, { verified: true, phone: "08031234567" });
  t("admin can't double-assign a verified number", r.status === 409);
  r = await C.ada.req("POST", "/api/phone/verify", { phone: "08031234567" });
  t("re-verifying the same number → 409", r.status === 409);
  r = await C.admin.req("PATCH", `/api/admin/users/${adaId}/phone`, { verified: false });
  t("admin can unverify", r.status === 200 && r.json.data.user.phoneVerified === false);
  await C.admin.req("PATCH", `/api/admin/users/${adaId}/phone`, { verified: true });
  r = await C.admin.req("PATCH", `/api/admin/users/${bolaId}/phone`, { verified: true });
  t("admin verify with no number on file → 400", r.status === 400);
  s1.kill(); await sleep(500);

  // ── Automatic (WhatsApp Cloud API) ────────────────────────────────────
  const waEnv = { WHATSAPP_TOKEN: "EAAG-test", WHATSAPP_PHONE_NUMBER_ID: "PNID123", WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_NUMBER: "+234 809 999 9999", WHATSAPP_VERIFY_TOKEN: "my-verify-token" };
  const s2 = await start(5105, uri, waEnv);
  const Q = 5105;
  for (const n of Object.keys(C)) { C[n].port = Q; }
  const meta = new Client(Q);

  r = await meta.req("GET", "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123");
  t("webhook handshake rejects wrong token", r.status === 403);
  r = await meta.req("GET", "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=my-verify-token&hub.challenge=987654");
  t("webhook handshake echoes challenge", r.status === 200 && r.text === "987654", r.text);

  r = await C.bola.req("POST", "/api/phone/verify", { phone: "0809 111 2222" });
  const { code, whatsappUrl } = r.json?.data || {};
  t("automatic: code + link to verification number", r.json?.data?.method === "whatsapp" && /^VN-[2-9A-HJ-NP-Z]{6}$/.test(code) && whatsappUrl.startsWith("https://wa.me/2348099999999?text=") && decodeURIComponent(whatsappUrl).includes(code), J(r.json));
  const stored = (await user("bola@t.com")).phoneVerification;
  t("only the code's hash is stored", stored.codeHash && !JSON.stringify(stored).includes(code));

  let body = webhookBody("2348091112222", `Verify my TechNest number: ${code}`);
  r = await meta.req("POST", "/api/whatsapp/webhook", body, {}, true);
  t("unsigned webhook → 401", r.status === 401);
  r = await meta.req("POST", "/api/whatsapp/webhook", body, { "X-Hub-Signature-256": sign(body, "wrong") }, true);
  t("wrongly signed webhook → 401", r.status === 401);

  body = webhookBody("2347000000000", code);
  r = await meta.req("POST", "/api/whatsapp/webhook", body, { "X-Hub-Signature-256": sign(body) }, true);
  await sleep(300);
  t("code sent from a different number: not verified, told why", r.status === 200 && !(await user("bola@t.com")).phoneVerified && /different number/.test(waSent().at(-1)?.body.text.body) && waSent().at(-1).body.to === "2347000000000");

  const before = waSent().length;
  body = webhookBody("2348000123456", "hello, do you have iPhone 15?");
  await meta.req("POST", "/api/whatsapp/webhook", body, { "X-Hub-Signature-256": sign(body) }, true);
  await sleep(300);
  t("ordinary chat messages get no bot reply", waSent().length === before);

  const msgId = "wamid.ABC123";
  body = webhookBody("2348091112222", `verify my number vn ${code.slice(3).toLowerCase()} thanks`, msgId);
  r = await meta.req("POST", "/api/whatsapp/webhook", body, { "X-Hub-Signature-256": sign(body) }, true);
  await sleep(400);
  const bola = await user("bola@t.com");
  t("right number + code (any typing) → verified", bola.phoneVerified && bola.phone === "+2348091112222" && bola.phoneVerifiedVia === "whatsapp" && !bola.phoneVerification?.codeHash, J(bola));
  const reply = waSent().at(-1);
  t("bot replies ✅ via Cloud API", /verified/.test(reply.body.text.body) && reply.url === "https://graph.facebook.com/v23.0/PNID123/messages" && reply.headers.Authorization === "Bearer EAAG-test" && reply.body.to === "2348091112222");
  t("user notified in-app", (await notes.countDocuments({ recipient: bola._id, type: "account_update" })) === 1);
  const n = waSent().length;
  await meta.req("POST", "/api/whatsapp/webhook", body, { "X-Hub-Signature-256": sign(body) }, true);
  await sleep(300);
  t("Meta's retry of the same message is ignored", waSent().length === n);

  r = await C.chi.req("POST", "/api/phone/verify", { phone: "08092223333" });
  const code2 = r.json.data.code;
  await users.updateOne({ email: "chi@t.com" }, { $set: { "phoneVerification.expiresAt": new Date(Date.now() - 1000) } });
  body = webhookBody("2348092223333", code2);
  await meta.req("POST", "/api/whatsapp/webhook", body, { "X-Hub-Signature-256": sign(body) }, true);
  await sleep(300);
  t("expired code → not verified, told to get a new one", !(await user("chi@t.com")).phoneVerified && /expired/.test(waSent().at(-1).body.text.body));
  r = await C.chi.req("POST", "/api/phone/verify", { phone: "08092223333" });
  const code3 = r.json.data.code;
  body = webhookBody("2348092223333", code3);
  await meta.req("POST", "/api/whatsapp/webhook", body, { "X-Hub-Signature-256": sign(body) }, true);
  await sleep(300);
  t("new code works", (await user("chi@t.com")).phoneVerified === true);
  r = await C.chi.req("GET", "/api/listings");
  t("webhook doesn't break normal JSON routes", r.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(s2.log.split("\n").slice(-15).join("\n"));
  await mongoose.disconnect(); await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
