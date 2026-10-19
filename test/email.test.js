// End-to-end test of email verification, password reset, notifications and
// phone validation, against an in-memory MongoDB with email mocked.
const fs = require("fs");
const path = require("path");
const { baseEnv } = require("./helpers/env");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server-core");
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "technest-test-"));

const BACKEND = path.resolve(__dirname, "..");
const CLOUD = "testcloud";
const CLIENT = "https://client.test";
const EMAIL_LOG = path.join(TMP, "emails.jsonl");
let pass = 0, fail = 0;
const t = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  ← " + extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emails = () => (fs.existsSync(EMAIL_LOG) ? fs.readFileSync(EMAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const emailsTo = (addr) => emails().filter((e) => e.body.to[0].email === addr);
const linkIn = (e) => (e.body.htmlContent.match(/href="([^"]+)"/) || [])[1]?.replace(/&amp;/g, "&");

class Client {
  constructor(port) { this.port = port; this.cookies = {}; }
  async req(method, url, body, headers = {}) {
    const h = { "Content-Type": "application/json", ...headers };
    const c = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (c) h.Cookie = c;
    if (this.cookies.csrfToken) h["X-CSRF-Token"] = this.cookies.csrfToken;
    const res = await fetch(`http://localhost:${this.port}${url}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(";"); const i = kv.indexOf("=");
      this.cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json, location: res.headers.get("location") };
  }
}

const startServer = async (port, uri, extraEnv) => {
  const env = {
    ...baseEnv(), PORT: port, MONGO_URI: uri, NODE_ENV: "development", CLIENT_URL: CLIENT,
    JWT_SECRET: "j".repeat(40), JWT_REFRESH_SECRET: "r".repeat(40),
    CLOUDINARY_CLOUD_NAME: CLOUD, CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
    IMEI_HASH_SECRET: "h".repeat(40), PAYSTACK_SECRET_KEY: "", ANTHROPIC_API_KEY: "",
    EMAIL_PROVIDER: "", EMAIL_API_KEY: "", EMAIL_FROM: "", EMAIL_LOG,
    ...extraEnv,
  };
  const server = spawn("node", ["server.js"], { cwd: BACKEND, env });
  process.on("exit", () => server.kill());
  server.log = "";
  server.stdout.on("data", (d) => (server.log += d));
  server.stderr.on("data", (d) => (server.log += d));
  for (let i = 0; i < 60 && !server.log.includes("Server running"); i++) await sleep(250);
  if (!server.log.includes("Server running")) { console.log(server.log); process.exit(1); }
  return server;
};

const listing = (over = {}) => ({
  userName: "Seller", userPhone: "0803 123 4567", deviceName: "MacBook Air",
  deviceCategory: "laptop", subType: "macbook", estimatedMin: 300000, estimatedMax: 350000,
  images: [`https://res.cloudinary.com/${CLOUD}/image/upload/a.jpg`], ...over,
});

(async () => {
  if (fs.existsSync(EMAIL_LOG)) fs.unlinkSync(EMAIL_LOG);
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri("technest_test");
  const mongoose = require(path.join(BACKEND, "node_modules/mongoose"));
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const users = db.collection("users"), notes = db.collection("notifications");

  // ── 1. No email provider: nothing is blocked ──────────────────────────
  let server = await startServer(5101, uri, {});
  let A = new Client(5101);
  let r = await A.req("POST", "/api/auth/register", { name: "Early User", email: "early@t.com", password: "password123" });
  t("[no email] register works", r.status === 201, JSON.stringify(r.json));
  await sleep(300);
  t("[no email] link logged instead of sent", /\[email not configured\] to=early@t.com .*verify-email\//.test(server.log), server.log.slice(-300));
  t("[no email] nothing sent to provider", emails().length === 0);
  r = await A.req("POST", "/api/listings", listing());
  t("[no email] unverified user can still list", r.status === 201, JSON.stringify(r.json));
  server.kill(); await sleep(500);

  // ── 2. Brevo configured ───────────────────────────────────────────────
  server = await startServer(5102, uri, { EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "test-key", EMAIL_FROM: "hello@technest.test", EMAIL_FROM_NAME: "TechNest" });
  const P = 5102;
  const seller = new Client(P), v1 = new Client(P), v2 = new Client(P), admin = new Client(P), guest = new Client(P);

  r = await seller.req("POST", "/api/auth/register", { name: "<b>Sade</b> Bello", email: "seller@t.com", password: "password123" });
  t("register → 201, isVerified false", r.status === 201 && r.json.data.user.isVerified === false);
  await sleep(300);
  let mail = emailsTo("seller@t.com");
  t("verification email sent via Brevo", mail.length === 1 && mail[0].headers["api-key"] === "test-key" && mail[0].body.sender.email === "hello@technest.test", JSON.stringify(mail));
  t("subject + link to CLIENT_URL/api/auth/verify-email", mail[0]?.body.subject === "Confirm your email for TechNest" && linkIn(mail[0]).startsWith(`${CLIENT}/api/auth/verify-email/`), linkIn(mail[0] || { body: { htmlContent: "" } }));
  t("user's name is HTML-escaped in email", mail[0]?.body.htmlContent.includes("&lt;b&gt;Sade&lt;/b&gt;") && !mail[0].body.htmlContent.includes("<b>Sade"));
  t("plain-text version included", mail[0]?.body.textContent.includes("Confirm my email:"));
  const firstToken = linkIn(mail[0]).split("/").pop();
  const stored = await users.findOne({ email: "seller@t.com" });
  t("only the token hash is stored", stored.verificationToken && stored.verificationToken !== firstToken && stored.verificationToken.length === 64);

  r = await seller.req("POST", "/api/listings", listing());
  t("unverified → 403 email_not_verified (with message + error)", r.status === 403 && r.json.code === "email_not_verified" && r.json.error && r.json.message, JSON.stringify(r.json));
  r = await seller.req("POST", "/api/transactions", { type: "buy", listingId: "000000000000000000000000" });
  t("unverified buy request → 403", r.status === 403 && r.json.code === "email_not_verified");
  r = await seller.req("POST", "/api/imei/stolen-reports", {});
  t("unverified stolen report → 403", r.status === 403);

  r = await seller.req("POST", "/api/auth/resend-verification");
  t("resend → 200", r.status === 200 && /seller@t.com/.test(r.json.message), JSON.stringify(r.json));
  mail = emailsTo("seller@t.com");
  const newToken = linkIn(mail[mail.length - 1]).split("/").pop();
  t("resend issues a new link", mail.length === 2 && newToken !== firstToken);

  r = await guest.req("GET", `/api/auth/verify-email/${firstToken}`, null, { Accept: "text/html" });
  t("old link (replaced) → redirect ?verified=invalid", r.status === 302 && r.location === `${CLIENT}/auth/login?verified=invalid`, `${r.status} ${r.location}`);
  r = await guest.req("GET", `/api/auth/verify-email/${newToken}`, null, { Accept: "text/html,application/xhtml+xml" });
  t("browser click → redirect ?verified=success", r.status === 302 && r.location === `${CLIENT}/auth/login?verified=success`, `${r.status} ${r.location}`);
  r = await guest.req("GET", `/api/auth/verify-email/${newToken}`, null, { Accept: "application/json" });
  t("API client gets JSON 400 for used link", r.status === 400 && r.json.success === false);
  r = await seller.req("GET", "/api/me");
  t("/api/me shows isVerified true", r.json.data.isVerified === true);
  r = await seller.req("POST", "/api/auth/resend-verification");
  t("resend when verified → 'already verified'", r.status === 200 && /already verified/.test(r.json.message));

  // Phone validation + normalization
  r = await seller.req("POST", "/api/listings", listing({ userPhone: "12345" }));
  t("bad phone → 400", r.status === 400 && /Nigerian phone/.test(r.json.error), JSON.stringify(r.json));
  r = await seller.req("POST", "/api/listings", listing({ userPhone: "+234-803-123-4567" }));
  t("verified user can list; phone normalized to +234", r.status === 201 && r.json.data.listing.userPhone === "+2348031234567", JSON.stringify(r.json));
  const lid = r.json.data.listing._id;
  r = await seller.req("PATCH", `/api/listings/${lid}`, { userPhone: "0700000" });
  t("PATCH bad phone → 400", r.status === 400);
  r = await seller.req("PATCH", `/api/listings/${lid}`, { userPhone: "2348091234567" });
  t("PATCH phone normalized", r.status === 200 && r.json.data.listing.userPhone === "+2348091234567", JSON.stringify(r.json));

  // Vendors + admin
  for (const [c, e] of [[v1, "v1@t.com"], [v2, "v2@t.com"], [admin, "admin@t.com"]])
    await c.req("POST", "/api/auth/register", { name: e.split("@")[0].toUpperCase(), email: e, password: "password123" });
  await users.updateMany({ email: { $in: ["v1@t.com", "v2@t.com"] } }, { $set: { userType: "vendor", isVerified: true } });
  await users.updateOne({ email: "v1@t.com" }, { $set: { vendorVerified: true } });
  await users.updateOne({ email: "admin@t.com" }, { $set: { userType: "admin" } });
  const v2Id = (await users.findOne({ email: "v2@t.com" }))._id;
  const sellerId = stored._id;

  r = await v2.req("PATCH", "/api/vendor/verify", { phone: "080", businessRegNumber: "RC123", shopAddress: "Ikeja" });
  t("vendor application with bad phone → 400", r.status === 400);
  r = await v2.req("PATCH", "/api/vendor/verify", { phone: "0803 999 8888", businessRegNumber: "RC123", shopAddress: "Ikeja" });
  t("vendor application phone normalized", r.status === 200 && r.json.data.vendorProfile.phone === "+2348039998888", JSON.stringify(r.json));
  let before = emails().length;
  r = await admin.req("PATCH", `/api/admin/vendors/${v2Id}/approve`);
  await sleep(300);
  t("vendor approved → in-app + email", r.status === 200 && (await notes.countDocuments({ recipient: v2Id, type: "account_update" })) === 1 && emailsTo("v2@t.com").some((e) => /approved TechNest vendor/.test(e.body.subject)));

  r = await admin.req("POST", "/api/admin/listings/x/review"); // warm-up noop
  before = emails().length;
  r = await admin.req("PATCH", `/api/admin/listings/${lid}/approve`);
  await sleep(400);
  t("approve listing → 200", r.status === 200, JSON.stringify(r.json));
  const ownerNote = await notes.findOne({ recipient: sellerId, type: "listing_update" });
  t("owner notified listing is live (in-app + email)", ownerNote && /live/.test(ownerNote.title) && emailsTo("seller@t.com").some((e) => e.body.subject === "Your listing is live"));
  const vendorNotes = await notes.find({ type: "new_cash_listing", listing: new mongoose.Types.ObjectId(lid) }).toArray();
  t("each approved vendor gets their own copy (2), no broadcast doc", vendorNotes.length === 2 && vendorNotes.every((n) => n.recipientType === "specific"), JSON.stringify(vendorNotes.map((n) => n.recipientType)));
  t("vendors are NOT emailed about every new listing", !emails().slice(before).some((e) => ["v1@t.com", "v2@t.com"].includes(e.body.to[0].email)));

  r = await v1.req("GET", "/api/notifications");
  const v1Note = r.json.data.notifications.find((n) => n.type === "new_cash_listing");
  await v1.req("PATCH", "/api/notifications", { id: v1Note._id });
  r = await v2.req("GET", "/api/notifications");
  t("read state is per vendor now", r.json.data.notifications.find((n) => n.type === "new_cash_listing")?.read === false);

  r = await v1.req("POST", "/api/vendor/bid", { listingId: lid, amount: 320000, message: "Can pick up today" });
  await sleep(300);
  t("vendor bid → seller notified in-app + email", r.status === 201 && (await notes.countDocuments({ recipient: sellerId, type: "bid_placed" })) === 1 && emailsTo("seller@t.com").some((e) => e.body.subject === "New offer on your listing"), JSON.stringify(r.json));

  r = await seller.req("POST", "/api/listings", listing({ deviceName: "HP Spectre" }));
  const lid2 = r.json.data.listing._id;
  r = await admin.req("PATCH", `/api/admin/listings/${lid2}/reject`, { reason: "Photos are stock images" });
  await sleep(300);
  const rej = await notes.findOne({ recipient: sellerId, type: "listing_update", title: /wasn't approved/ });
  t("reject → owner told why", rej && /stock images/.test(rej.message) && emailsTo("seller@t.com").some((e) => /wasn't approved/.test(e.body.subject)));

  // Email failure doesn't break the request
  const bad = new Client(P);
  r = await bad.req("POST", "/api/auth/register", { name: "Fail Me", email: "fail@t.com", password: "password123" });
  await sleep(300);
  t("provider error on signup email → signup still 201", r.status === 201 && /Email to fail@t.com failed: 500/.test(server.log), server.log.slice(-200));

  // Forgot / reset password
  before = emails().length;
  r = await guest.req("POST", "/api/auth/forgot-password", { email: "nobody@t.com" });
  const unknownMsg = r.json.message;
  r = await guest.req("POST", "/api/auth/forgot-password", { email: "SELLER@t.com" });
  await sleep(300);
  t("forgot-password answers the same for unknown + known email", r.status === 200 && r.json.message === unknownMsg);
  const resetMails = emails().slice(before);
  t("reset email only sent to the real account", resetMails.length === 1 && resetMails[0].body.to[0].email === "seller@t.com");
  const resetLink = linkIn(resetMails[0]);
  t("reset link → CLIENT_URL/auth/reset-password?token=", resetLink.startsWith(`${CLIENT}/auth/reset-password?token=`), resetLink);
  const resetToken = new URL(resetLink).searchParams.get("token");
  r = await guest.req("POST", "/api/auth/reset-password", { token: "nope", password: "newpassword1" });
  t("reset with wrong token → 400", r.status === 400);
  r = await guest.req("POST", "/api/auth/reset-password", { token: resetToken, password: "short" });
  t("reset with short password → 400", r.status === 400);
  r = await guest.req("POST", "/api/auth/reset-password", { token: resetToken, password: "newpassword1" });
  t("reset → 200", r.status === 200, JSON.stringify(r.json));
  r = await guest.req("POST", "/api/auth/reset-password", { token: resetToken, password: "another123" });
  t("reset link can't be reused", r.status === 400);
  r = await new Client(P).req("POST", "/api/auth/login", { email: "seller@t.com", password: "password123" });
  t("old password no longer works", r.status === 401);
  r = await new Client(P).req("POST", "/api/auth/login", { email: "seller@t.com", password: "newpassword1" });
  t("new password works (or only blocked by the auth rate limit)", r.status === 200 || r.status === 429, String(r.status));
  if (r.status === 429) {
    const u = await users.findOne({ email: "seller@t.com" });
    const bcrypt = require(path.join(BACKEND, "node_modules/bcryptjs"));
    t("new password hash matches", await bcrypt.compare("newpassword1", u.password));
    t("account marked verified + reset token cleared", u.isVerified === true && !u.passwordResetToken);
  }

  // Resend limiter (5/hour): seller already used 2
  const lim = new Client(P);
  await lim.req("POST", "/api/auth/register", { name: "Lim", email: "lim@t.com", password: "password123" });
  let last; for (let i = 0; i < 6; i++) last = await lim.req("POST", "/api/auth/resend-verification");
  t("resend is rate-limited", last.status === 429, String(last.status));

  console.log(`\n${pass} passed, ${fail} failed`);
  server.kill(); await mongoose.disconnect(); await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
