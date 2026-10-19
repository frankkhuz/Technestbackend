// End-to-end test: WhatsApp orders + listing holds, identity checks, vendor
// types, smart vendor matching, categories/filters, bulk uploads, flash
// sale, announcements — against an in-memory MongoDB with email,
// Paystack and Cloudinary mocked.
const fs = require("fs");
const path = require("path");
const { baseEnv } = require("./helpers/env");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { MongoMemoryServer } = require("mongodb-memory-server-core");
const TMP = fs.mkdtempSync(path.join(require("os").tmpdir(), "technest-test-"));

const BACKEND = path.resolve(__dirname, "..");
const CLOUD = "testcloud";
const SECRET = "cloudsecret";
const EMAIL_LOG = path.join(TMP, "emails3.jsonl");
const PORT = 5103;
let pass = 0, fail = 0;
const t = (label, ok, extra = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : "  ← " + String(extra).slice(0, 400)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emails = () => (fs.existsSync(EMAIL_LOG) ? fs.readFileSync(EMAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
const J = (x) => JSON.stringify(x);

let ipSeq = 1;
class Client {
  // Each test client gets its own address so the per-IP rate limits behave as for real users
  constructor() { this.cookies = {}; this.ip = `10.0.0.${ipSeq++}`; }
  async req(method, url, body, headers = {}) {
    const h = { "Content-Type": "application/json", "X-Forwarded-For": this.ip, ...headers };
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
  if (fs.existsSync(EMAIL_LOG)) fs.unlinkSync(EMAIL_LOG);
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri("technest_test");
  const env = {
    ...baseEnv(), PORT, MONGO_URI: uri, NODE_ENV: "development", CLIENT_URL: "https://client.test",
    JWT_SECRET: "j".repeat(40), JWT_REFRESH_SECRET: "r".repeat(40),
    CLOUDINARY_CLOUD_NAME: CLOUD, CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: SECRET,
    IMEI_HASH_SECRET: "h".repeat(40), PAYSTACK_SECRET_KEY: "sk_test_mock", ANTHROPIC_API_KEY: "",
    EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "k", EMAIL_FROM: "hello@technest.test", EMAIL_LOG,
    INTERNAL_CRON_SECRET: "cron-secret-123", ONLINE_PAYMENTS: "", SUPPORT_WHATSAPP: "2348000000000",
  };
  const server = spawn("node", ["server.js"], { cwd: BACKEND, env });
  process.on("exit", () => server.kill());
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 80 && !log.includes("Server running"); i++) await sleep(250);
  if (!log.includes("Server running")) { console.log(log); process.exit(1); }
  await sleep(500);

  const mongoose = require(path.join(BACKEND, "node_modules/mongoose"));
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const users = db.collection("users"), notes = db.collection("notifications"), listings = db.collection("listings");
  const oid = (s) => new mongoose.Types.ObjectId(String(s));
  const idOf = async (email) => (await users.findOne({ email }))._id;
  const notesFor = async (email, type) => notes.find({ recipient: await idOf(email), ...(type ? { type } : {}) }).toArray();

  t("default categories created on startup", /Added \d+ default product categories/.test(log), log.slice(-300));

  // ── Accounts ──────────────────────────────────────────────────────────
  const C = {};
  for (const name of ["admin", "cust", "seller", "v1", "v2", "v3", "v4", "v5", "john", "unver"]) {
    C[name] = new Client();
    await C[name].req("POST", "/api/auth/register", { name: `${name[0].toUpperCase()}${name.slice(1)} Test`, email: `${name}@t.com`, password: "password123" });
  }
  await users.updateMany({ email: { $ne: "unver@t.com" } }, { $set: { isVerified: true } });
  await users.updateOne({ email: "admin@t.com" }, { $set: { userType: "admin" } });
  await users.updateOne({ email: "cust@t.com" }, { $set: { name: "Sade Bello" } });
  for (const v of ["v1", "v2", "v3", "v4", "v5"]) await users.updateOne({ email: `${v}@t.com` }, { $set: { userType: "vendor" } });
  const ids = {};
  for (const n of Object.keys(C)) ids[n] = await idOf(`${n}@t.com`);

  // ── Private uploads ───────────────────────────────────────────────────
  let r = await C.cust.req("POST", "/api/uploads/signature", { purpose: "private" });
  const d = r.json?.data || {};
  const expectSig = crypto.createHash("sha1").update(`folder=${d.folder}&timestamp=${d.timestamp}&type=authenticated${SECRET}`).digest("hex");
  t("private upload: own folder, authenticated, valid signature", d.folder === `technest/private/${ids.cust}` && d.type === "authenticated" && d.signature === expectSig, J(d));
  r = await C.cust.req("POST", "/api/uploads/signature", {});
  t("listing upload signature unchanged", r.json.data.folder === "technest/listings" && !r.json.data.type);

  // ── #3 Vendor application with types + CAC ────────────────────────────
  const priv = (n, f) => `technest/private/${ids[n]}/${f}`;
  r = await C.v1.req("PATCH", "/api/vendor/verify", { phone: "08031112222", businessRegNumber: "ABC", shopAddress: "Ikeja" });
  t("bad CAC number → 400", r.status === 400 && /CAC/.test(r.json.message), J(r.json));
  r = await C.v1.req("PATCH", "/api/vendor/verify", { phone: "08031112222", businessRegNumber: "rc 123-4567", shopAddress: "Ikeja", cacCertificateId: priv("v2", "cac") });
  t("someone else's CAC upload → 400", r.status === 400);
  r = await C.v1.req("PATCH", "/api/vendor/verify", {
    phone: "08031112222", businessRegNumber: "rc 123-4567", shopAddress: "Computer Village, Ikeja", businessName: "Ade Phones",
    vendorTypes: ["phone_dealer", "bogus"], brands: ["Apple", "Samsung"], states: ["lagos state", "Narnia"], city: "Ikeja", cacCertificateId: priv("v1", "cac_abc"),
  });
  const vp = r.json?.data?.vendorProfile || {};
  t("vendor application saved + normalized", r.status === 200 && vp.businessRegNumber === "RC1234567" && J(vp.vendorTypes) === '["phone_dealer"]' && J(vp.states) === '["Lagos"]' && vp.businessName === "Ade Phones", J(r.json));
  t("CAC doc not in public vendorProfile", !J(vp).includes("cac_abc"));
  t("admins alerted about vendor application", (await notesFor("admin@t.com", "admin_alert")).some((n) => /Ade Phones/.test(n.message)));
  r = await C.admin.req("GET", "/api/admin/vendors/pending");
  const pend = r.json?.data?.vendors?.find((v) => v.email === "v1@t.com");
  t("admin sees signed CAC link", pend && /\/authenticated\/s--[\w-]+--\//.test(pend.cacCertificateUrl || "") && !pend.vendorDocuments, J(pend));
  await C.admin.req("PATCH", `/api/admin/vendors/${ids.v1}/approve`);
  // Other vendors set directly
  const setVendor = (n, profile, approved = true) => users.updateOne({ _id: ids[n] }, { $set: { vendorVerified: approved, vendorProfile: { phone: "+2348030000000", businessRegNumber: "RC1", shopAddress: "x", ...profile } } });
  await setVendor("v2", { businessName: "Nationwide Gadgets", vendorTypes: ["phone_dealer"] }); // nationwide (no states)
  await setVendor("v3", { businessName: "Abuja Phones", vendorTypes: ["phone_dealer"], states: ["FCT"] });
  await setVendor("v4", { businessName: "Fix It Lagos", vendorTypes: ["repairs"], states: ["Lagos"], repairServices: ["screen-replacement-oem"] });
  await setVendor("v5", { businessName: "Pending Shop", vendorTypes: ["phone_dealer"], states: ["Lagos"] }, false);

  r = await C.cust.req("GET", "/api/vendors/directory?type=repairs&state=lagos");
  t("directory filters by type + state, no contacts", r.json?.data?.vendors?.length === 1 && r.json.data.vendors[0].name === "Fix It Lagos" && !J(r.json).includes("+234"), J(r.json));
  r = await C.cust.req("GET", "/api/vendors/directory?state=Lagos");
  t("directory: nationwide vendors show for any state, unapproved hidden", r.json.data.vendors.some((v) => v.name === "Nationwide Gadgets") && !r.json.data.vendors.some((v) => v.name === "Pending Shop") && !r.json.data.vendors.some((v) => v.name === "Abuja Phones"), J(r.json.data.vendors.map((v) => v.name)));

  // ── #2 Identity ───────────────────────────────────────────────────────
  const idBody = (over) => ({ fullName: "Sade Bello", idType: "nin_slip", idDocumentId: priv("cust", "id1"), selfieId: priv("cust", "selfie1"), bankCode: "058", bankName: "GTBank", accountNumber: "0123456789", ...over });
  r = await C.cust.req("POST", "/api/identity", idBody({ idDocumentId: priv("john", "id1") }));
  t("identity: another user's upload → 400", r.status === 400);
  r = await C.cust.req("POST", "/api/identity", idBody({ fullName: "Sade" }));
  t("identity: needs full name", r.status === 400);
  r = await C.cust.req("POST", "/api/identity", idBody({ accountNumber: "0000000000" }));
  t("identity: unknown bank account → 400", r.status === 400 && /bank account/.test(r.json.message), J(r.json));
  r = await C.cust.req("POST", "/api/identity", idBody());
  t("identity submitted → pending", r.status === 200 && r.json.data.status === "pending" && r.json.data.accountLast4 === "6789", J(r.json));
  const stored = (await users.findOne({ _id: ids.cust })).identity;
  t("bank name check: match (order ignored)", stored.nameMatch === "match" && stored.accountName === "BELLO SADE ADUNNI", J(stored));
  r = await C.cust.req("POST", "/api/identity", idBody());
  t("identity: can't resubmit while pending", r.status === 409);
  r = await C.john.req("POST", "/api/identity", { fullName: "John Test", idType: "drivers_licence", idDocumentId: priv("john", "a"), selfieId: priv("john", "b"), bankCode: "058", bankName: "GTBank", accountNumber: "0987654321" });
  t("bank name check: mismatch flagged", r.status === 200 && (await users.findOne({ _id: ids.john })).identity.nameMatch === "mismatch", `${r.status} ${J(r.json)}`);
  r = await C.unver.req("POST", "/api/identity", idBody());
  t("identity needs verified email", r.status === 403 && r.json.code === "email_not_verified");
  r = await C.admin.req("GET", "/api/admin/identity");
  const person = r.json?.data?.people?.find((p) => p.email === "cust@t.com");
  t("admin review list: signed photo links, no raw ids or bank code", person && /authenticated\/s--/.test(person.identity.idDocumentUrl) && /authenticated\/s--/.test(person.identity.selfieUrl) && !J(person).includes("id1\"") && !("bankCode" in person.identity) && person.identity.nameMatch === "match", J(person));
  r = await C.admin.req("PATCH", `/api/admin/identity/${ids.cust}`, { status: "verified" });
  t("admin verifies → badge on", r.status === 200 && r.json.data.identityVerified === true);
  t("user notified (identity_update)", (await notesFor("cust@t.com", "identity_update")).length === 1);
  r = await C.admin.req("PATCH", `/api/admin/identity/${ids.john}`, { status: "rejected", reason: "Name on bank account doesn't match the ID" });
  r = await C.john.req("GET", "/api/identity");
  t("rejected user sees reason, can resubmit", r.json?.data?.status === "rejected" && /doesn't match/.test(r.json.data.rejectionReason), J(r.json));
  r = await C.cust.req("GET", "/api/me");
  t("/api/me has identityVerified + identityStatus", r.json.data.identityVerified === true && r.json.data.identityStatus === "verified");

  // ── #5 Categories + products ──────────────────────────────────────────
  r = await C.cust.req("GET", "/api/categories");
  const tree = r.json?.data?.categories || [];
  const gaming = tree.find((c) => c.slug === "gaming");
  t("category tree: groups with children", gaming && gaming.children.map((c) => c.slug).join() === "console,gaming-pc,controller,gaming-accessory,game" && tree.some((c) => c.slug === "smart-glasses") && tree.some((c) => c.slug === "projector"), J(tree.map((c) => c.slug)));
  t("existing catalog slugs still exist", ["flagship", "mid-range", "budget", "laptop", "tablet", "watch", "console", "camera", "security", "drone", "audio", "power", "router", "mifi", "accessory", "keyboard", "stylus"].every((s) => tree.some((c) => c.slug === s || c.children.some((k) => k.slug === s))));

  const newProduct = (over) => ({ slug: "airpods-pro-2", type: "gadget", name: "AirPods Pro 2", brand: "Apple", category: "headphones", priceUkUsed: 180000, priceBrandNew: 250000, attributes: { type: "In-ear / earbuds", connectivity: "wireless", noiseCancelling: "yes", batteryLife: 6 }, ...over });
  r = await C.admin.req("POST", "/api/products", newProduct({ category: "nope" }));
  t("product with unknown category → 400", r.status === 400 && /Unknown category/.test(r.json.message));
  r = await C.admin.req("POST", "/api/products", newProduct({ attributes: { colour: "red" } }));
  t("product with a filter its category doesn't have → 400", r.status === 400 && /isn't a filter/.test(r.json.message), J(r.json));
  r = await C.admin.req("POST", "/api/products", newProduct({ attributes: { type: "Earmuffs" } }));
  t("product with an invalid option → 400", r.status === 400 && /must be one of/.test(r.json.message));
  r = await C.admin.req("POST", "/api/products", newProduct());
  t("product created; attributes normalized", r.status === 201 && J(r.json.data.product.attributes) === J({ type: "In-ear / earbuds", connectivity: "Wireless", noiseCancelling: true, batteryLife: 6 }), J(r.json));
  await C.admin.req("POST", "/api/products", newProduct({ slug: "sony-xm5", name: "Sony WH-1000XM5", brand: "Sony", priceUkUsed: 300000, priceBrandNew: 420000, attributes: { type: "Over-ear", connectivity: "Wireless + wired", noiseCancelling: true, batteryLife: 30 } }));
  await C.admin.req("POST", "/api/products", newProduct({ slug: "wired-buds", name: "Basic Wired Buds", brand: "Oraimo", priceUkUsed: 5000, priceBrandNew: 8000, attributes: { type: "In-ear / earbuds", connectivity: "Wired", noiseCancelling: false } }));
  await C.admin.req("POST", "/api/products", { slug: "legacy-audio", type: "gadget", name: "Legacy speaker", brand: "JBL", category: "audio", priceUkUsed: 50000, priceBrandNew: 70000 });
  await C.admin.req("POST", "/api/products", { slug: "iphone-13-pro", type: "phone", name: "iPhone 13 Pro", brand: "Apple", category: "flagship", priceUkUsed: 600000, priceBrandNew: 900000, storage: ["128GB"] });
  r = await C.cust.req("GET", "/api/categories/headphones");
  const f = r.json?.data?.filters;
  const fa = (k) => f?.attributes.find((a) => a.key === k);
  t("filters: counts per option", f?.total === 3 && fa("connectivity").options.find((o) => o.value === "Wireless").count === 1 && fa("connectivity").options.find((o) => o.value === "Wired").count === 1 && fa("noiseCancelling").options.find((o) => o.value === "true").count === 2, J(f));
  t("filters: number range, brands, price, param names", fa("batteryLife").min === 6 && fa("batteryLife").max === 30 && J(fa("batteryLife").params) === '["a.batteryLife_min","a.batteryLife_max"]' && f.brands.length === 3 && f.price.min === 5000 && r.json.data.parent.slug === "audio");
  r = await C.cust.req("GET", "/api/products?category=audio");
  t("group category includes subcategories + legacy items", r.json.data.total === 4, r.json.data.total);
  r = await C.cust.req("GET", "/api/products?category=headphones&a.noiseCancelling=true&a.type=Over-ear,On-ear");
  t("attribute filters (boolean + any-of)", r.json.data.total === 1 && r.json.data.products[0].id === "sony-xm5", J(r.json.data.products.map((p) => p.id)));
  r = await C.cust.req("GET", "/api/products?category=headphones&a.batteryLife_min=10");
  t("number range filter", r.json.data.total === 1);
  r = await C.cust.req("GET", "/api/products?category=headphones&maxPrice=200000");
  t("price filter", r.json.data.total === 2);
  r = await C.admin.req("PATCH", "/api/products/airpods-pro-2", { attributes: { connectivity: "Bluetooth 9" } });
  t("PATCH invalid attribute → 400", r.status === 400);
  r = await C.admin.req("PATCH", "/api/products/airpods-pro-2", { priceUkUsed: 175000 });
  t("PATCH unrelated field keeps attributes", r.status === 200 && r.json.data.product.attributes.connectivity === "Wireless");
  r = await C.admin.req("POST", "/api/categories/admin", { slug: "vr-headset", name: "VR headsets", parent: "console", attributes: [] });
  t("category can't nest 3 levels", r.status === 400);
  r = await C.admin.req("POST", "/api/categories/admin", { slug: "vr-headset", name: "VR headsets", parent: "gaming", attributes: [{ key: "refreshRate", label: "Refresh rate", type: "number", unit: "Hz" }, { key: "standalone", type: "boolean", label: "Standalone" }, { key: "bad key", type: "select" }] });
  t("bad filter key rejected", r.status === 400 && /camelCase/.test(r.json.message));
  r = await C.admin.req("POST", "/api/categories/admin", { slug: "vr-headset", name: "VR headsets", parent: "gaming", attributes: [{ key: "refreshRate", label: "Refresh rate", type: "number", unit: "Hz" }, { key: "standalone", type: "boolean", label: "Standalone" }] });
  t("admin adds a new category with its own filters", r.status === 201);
  r = await C.cust.req("GET", "/api/categories");
  t("new category shows in the menu without a deploy", r.json.data.categories.find((c) => c.slug === "gaming").children.some((c) => c.slug === "vr-headset"));
  r = await C.cust.req("POST", "/api/categories/admin", { slug: "x", name: "x" });
  t("non-admin can't add categories", r.status === 403);

  // ── #6 Bulk product upload ────────────────────────────────────────────
  const csv = [
    "slug,type,name,brand,category,priceUkUsed,priceBrandNew,tags,inStock,type_,connectivity,waterproof,power",
  ].join("\n");
  // (the header above is replaced below; a "type" column clashes between product type and speaker type, so speaker rows use category filters only)
  const bulk = [
    "name,type,brand,category,priceUkUsed,priceBrandNew,tags,inStock,connectivity,waterproof,power",
    "JBL Flip 6,gadget,JBL,speaker,\"₦85,000\",120000,portable|bluetooth,yes,Bluetooth|AUX,yes,20",
    "AirPods Pro 2,,,,170000,,,,,,", // update existing by name→slug
    "Mystery,gadget,X,no-such-cat,1,2,,,,,",
    "Bad Filter,gadget,X,speaker,1,2,,,Telepathy,,",
    "Missing Price,gadget,X,speaker,,,,,,,",
  ].join("\n");
  r = await C.admin.req("POST", "/api/products/bulk", { csv: bulk, dryRun: true });
  t("bulk dry run: 1 create, 1 update, 3 errors, nothing saved", r.json?.data?.created === 1 && r.json.data.updated === 1 && r.json.data.failed === 3 && r.json.data.dryRun === true && !(await db.collection("products").findOne({ slug: "jbl-flip-6" })), J(r.json));
  t("bulk errors explain each row", J(r.json.data.rows).includes("Unknown category") && J(r.json.data.rows).includes("Telepathy") && J(r.json.data.rows).includes("New products need"));
  r = await C.admin.req("POST", "/api/products/bulk", { csv: bulk });
  const jbl = await db.collection("products").findOne({ slug: "jbl-flip-6" });
  t("bulk saved: prices parsed, lists split, filters validated", r.json.data.created === 1 && jbl && jbl.priceUkUsed === 85000 && J(jbl.tags) === '["portable","bluetooth"]' && J(jbl.attributes) === J({ connectivity: ["Bluetooth", "AUX"], waterproof: true, power: 20 }), J(jbl));
  t("bulk update kept other fields", (await db.collection("products").findOne({ slug: "airpods-pro-2" })).priceUkUsed === 170000 && (await db.collection("products").findOne({ slug: "airpods-pro-2" })).attributes.connectivity === "Wireless");
  const bigRows = Array.from({ length: 300 }, (_, i) => `Bulk Cable ${i} with a fairly long descriptive product name,gadget,Anker,cable,${2000 + i},${3000 + i}`);
  r = await C.admin.req("POST", "/api/products/bulk", { csv: ["name,type,brand,category,priceUkUsed,priceBrandNew", ...bigRows].join("\n") });
  t("bulk accepts uploads well over the 10kb default limit", r.status === 200 && r.json.data.created === 300, `${r.status} ${J(r.json).slice(0, 200)}`);
  r = await C.cust.req("POST", "/api/listings", { x: "y".repeat(12000) });
  t("other routes still reject big bodies", r.status === 413 || r.status === 500 || r.status === 400, r.status);

  // Vendor bulk stock
  r = await C.v1.req("POST", "/api/vendor/inventory/bulk", { csv: "deviceName,buyPrice,sellPrice,condition,storage,quantity\niPhone 13 Pro,500000,580000,UK Used,128GB,2\nGalaxy S23,1,2,Broken,,\n,1,2,,," });
  t("vendor bulk stock: quantity expands, bad rows reported", r.status === 200 && r.json.data.added === 2 && r.json.data.failed === 2, J(r.json));
  r = await C.v5.req("POST", "/api/vendor/inventory/bulk", { csv: "deviceName,buyPrice,sellPrice\nX,1,2" });
  t("unapproved vendor can't bulk upload", r.status === 403);
  await db.collection("inventoryitems").insertOne({ vendor: ids.v2, deviceName: "Galaxy S23 Ultra", buyPrice: 1, sellPrice: 2, condition: "UK Used", status: "in_stock" });

  // ── #7 Flash sale ─────────────────────────────────────────────────────
  const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  r = await C.admin.req("PATCH", "/api/products/sony-xm5", { sale: { priceUkUsed: 350000, endsAt: soon(5) } });
  t("sale above normal price → 400", r.status === 400);
  r = await C.admin.req("PATCH", "/api/products/sony-xm5", { sale: { priceUkUsed: 250000, endsAt: soon(5), label: "Weekend deal" } });
  t("live sale set", r.status === 200 && r.json.data.product.sale.active === true && r.json.data.product.sale.label === "Weekend deal", J(r.json));
  await C.admin.req("PATCH", "/api/products/wired-buds", { sale: { priceUkUsed: 4000, startsAt: soon(24), endsAt: soon(48) } });
  r = await C.cust.req("GET", "/api/products/flash-sale");
  t("flash sale page: live + upcoming + serverTime", r.json.data.products.map((p) => p.id).join() === "sony-xm5" && r.json.data.upcoming.map((p) => p.id).join() === "wired-buds" && r.json.data.serverTime, J(r.json.data));
  r = await C.cust.req("GET", "/api/products?onSale=true");
  t("onSale filter", r.json.data.total === 1);
  r = await C.admin.req("POST", "/api/products/flash-sale", { slugs: ["airpods-pro-2", "ghost"], percentOff: 10, endsAt: soon(2) });
  const ap = await db.collection("products").findOne({ slug: "airpods-pro-2" });
  t("bulk sale: % off rounded to ₦100", r.json.data.updated === 1 && J(r.json.data.notFound) === '["ghost"]' && ap.sale.priceUkUsed === 153000 && ap.sale.priceBrandNew === 225000, J(ap.sale));

  // ── #1 WhatsApp orders ────────────────────────────────────────────────
  const guest = new Client();
  r = await guest.req("GET", "/api/order-requests/options");
  t("payment options: WhatsApp on, online 'Coming soon'", r.json.data.whatsapp.enabled && r.json.data.online.enabled === false && r.json.data.online.label === "Coming soon");
  r = await guest.req("POST", "/api/order-requests", { buyerName: "Guest Buyer", buyerPhone: "123", items: [{ itemId: "sony-xm5" }] });
  t("bad phone → 400", r.status === 400);
  r = await guest.req("POST", "/api/order-requests", { buyerName: "Guest Buyer", buyerPhone: "0803 555 1234", state: "lagos", items: [{ itemId: "sony-xm5", quantity: 2 }, { itemId: "iphone-13-pro", condition: "brand-new" }] });
  const or1 = r.json?.data;
  t("guest WhatsApp order: sale price used, reference, link", r.status === 201 && /^TN-[2-9A-HJ-NP-Z]{6}$/.test(or1.request.reference) && or1.request.amount === 250000 * 2 + 900000 && or1.request.state === "Lagos", J(r.json));
  const text = decodeURIComponent(or1?.whatsappUrl.split("text=")[1] || "");
  t("WhatsApp message has items, total, ref", or1.whatsappUrl.startsWith("https://wa.me/2348000000000?text=") && text.includes("Sony WH-1000XM5") && text.includes("₦1,400,000") && text.includes(or1.request.reference), text);
  t("admins alerted (in-app)", (await notesFor("admin@t.com", "order_request")).length === 1);
  await db.collection("products").updateOne({ slug: "wired-buds" }, { $set: { inStock: false } });
  r = await guest.req("POST", "/api/order-requests", { buyerName: "G", buyerPhone: "08035551234", items: [{ itemId: "wired-buds" }] });
  t("out of stock → 409", r.status === 409);

  // Listing order + hold
  r = await C.seller.req("POST", "/api/listings", { userName: "Seller", userPhone: "08031234567", deviceName: "MacBook Air M2", deviceCategory: "laptop", subType: "macbook", estimatedMin: 700000, estimatedMax: 750000, images: [`https://res.cloudinary.com/${CLOUD}/image/upload/a.jpg`] });
  const L1 = r.json.data.listing._id;
  await C.admin.req("PATCH", `/api/admin/listings/${L1}/approve`);
  r = await C.cust.req("POST", "/api/order-requests", { buyerPhone: "08035550000", listingId: L1 });
  const or2 = r.json?.data?.request;
  t("logged-in listing order uses account name", r.status === 201 && or2.buyerName === "Sade Bello" && or2.amount === 750000, J(r.json));
  r = await C.seller.req("POST", "/api/order-requests", { buyerPhone: "08035550000", listingId: L1 });
  t("seller can't order own listing", r.status === 400);
  r = await C.john.req("POST", "/api/order-requests", { buyerName: "John", buyerPhone: "08035550001", listingId: L1 });
  const or3 = r.json?.data?.request;
  r = await C.admin.req("PATCH", `/api/admin/order-requests/${or2.id}`, { status: "in_progress", adminNotes: "Called buyer" });
  t("admin starts order → 200", r.status === 200 && r.json.data.request.status === "in_progress", J(r.json));
  r = await guest.req("GET", `/api/listings/${L1}`);
  t("listing now shows isReserved / not available", r.json.data.listing.isReserved === true && r.json.data.listing.isAvailable === false, J(r.json.data.listing));
  t("seller told a buyer wants it", (await notesFor("seller@t.com", "listing_update")).some((n) => /buyer wants/.test(n.title)));
  r = await guest.req("GET", "/api/listings?available=true");
  t("?available=true hides held listing", !r.json.data.listings.some((l) => l._id === L1));
  r = await C.john.req("POST", "/api/transactions", { type: "buy", listingId: L1 });
  t("other buyer's request blocked while held", r.status === 409 && /finalising/.test(r.json.message), J(r.json));
  r = await C.admin.req("PATCH", `/api/admin/order-requests/${or3.id}`, { status: "in_progress" });
  t("second order can't take the same hold", r.status === 409);
  r = await C.v1.req("POST", "/api/vendor/bid", { listingId: L1, amount: 600000 });
  t("vendor bid blocked while held", r.status === 400);
  r = await C.admin.req("PATCH", `/api/admin/order-requests/${or2.id}`, { status: "completed" });
  const l1 = await listings.findOne({ _id: oid(L1) });
  const or3After = await db.collection("orderrequests").findOne({ _id: oid(or3.id) });
  t("complete → listing sold, hold cleared, rival order cancelled", r.status === 200 && l1.status === "sold" && !l1.reservedUntil && or3After.status === "cancelled", J({ l1: l1.status, or3: or3After.status }));
  t("seller + buyer notified", (await notesFor("seller@t.com", "listing_sold")).length === 1 && (await notesFor("cust@t.com", "order_request")).some((n) => /complete/.test(n.title)));
  r = await C.admin.req("PATCH", `/api/admin/order-requests/${or2.id}`, { status: "in_progress" });
  t("can't reopen a completed order", r.status === 409);
  r = await C.cust.req("GET", "/api/order-requests/mine");
  t("buyer's orders list", r.json.data.requests.length === 1 && r.json.data.requests[0].whatsappUrl);
  r = await C.admin.req("GET", "/api/admin/order-requests?status=new");
  t("admin list with counts", r.json.data.counts.completed === 1 && r.json.data.counts.cancelled === 1 && r.json.data.requests.every((x) => x.status === "new"), J(r.json.data.counts));

  // Cancel releases; expired hold frees
  r = await C.seller.req("POST", "/api/listings", { userName: "Seller", userPhone: "08031234567", deviceName: "HP Spectre", deviceCategory: "laptop", subType: "windows", estimatedMin: 1, estimatedMax: 2, images: [] });
  const L2 = r.json.data.listing._id;
  await C.admin.req("PATCH", `/api/admin/listings/${L2}/approve`);
  r = await C.cust.req("POST", "/api/order-requests", { buyerPhone: "08035550000", listingId: L2 });
  const or4 = r.json.data.request;
  await C.admin.req("PATCH", `/api/admin/order-requests/${or4.id}`, { status: "in_progress" });
  await C.admin.req("PATCH", `/api/admin/order-requests/${or4.id}`, { status: "cancelled" });
  t("cancel releases the hold", !(await listings.findOne({ _id: oid(L2) })).reservedUntil);
  await listings.updateOne({ _id: oid(L2) }, { $set: { reservedUntil: new Date(Date.now() - 1000), reservedFor: oid(or4.id) } });
  r = await C.john.req("POST", "/api/transactions", { type: "buy", listingId: L2 });
  t("expired hold doesn't block anyone", r.status === 201, J(r.json));

  // ── #4 Smart vendor matching ──────────────────────────────────────────
  r = await C.unver.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "iPhone 13 Pro", state: "Lagos" });
  t("posting a request needs verified email", r.status === 403);
  r = await C.cust.req("POST", "/api/requests", { type: "swap", category: "phone", deviceName: "iPhone 11", state: "Lagos" });
  t("swap needs wantedDevice", r.status === 400);
  r = await C.cust.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "iPhone 13 Pro", state: "Narnia" });
  t("unknown state → 400", r.status === 400);
  const before = emails().length;
  r = await C.cust.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "iPhone 13 Pro", storage: "128GB", budgetMax: 650000, state: "lagos", city: "Ikeja" });
  const RQ1 = r.json?.data?.request;
  t("request posted → matched 2 (local + nationwide, not Abuja/repairs/unapproved)", r.status === 201 && r.json.data.matchedVendors === 2 && /^RQ-/.test(RQ1.reference), J(r.json));
  const rq1 = await db.collection("devicerequests").findOne({ _id: oid(RQ1.id) });
  t("Lagos vendor with Apple + stock ranked first", String(rq1.matchedVendors[0]) === String(ids.v1) && String(rq1.matchedVendors[1]) === String(ids.v2), J(rq1.matchedVendors));
  await sleep(300);
  t("vendors notified in-app + email", (await notesFor("v1@t.com", "device_request")).length === 1 && (await notesFor("v2@t.com", "device_request")).length === 1 && emails().slice(before).filter((e) => /New buy request/.test(e.body.subject)).length === 2);
  const auto = (await notesFor("cust@t.com", "device_request")).find((n) => /We've got your request/.test(n.title));
  t("customer gets automatic confirmation with vendor count", auto && /to 2 vendors in Lagos/.test(auto.message), auto?.message);
  r = await C.v3.req("POST", `/api/requests/${RQ1.id}/offers`, { price: 1 });
  t("unmatched vendor can't offer", r.status === 404);
  r = await C.v3.req("GET", `/api/requests/${RQ1.id}`);
  t("unmatched vendor can't view", r.status === 404);
  const emailsBeforeOffers = emails().length;
  r = await C.v1.req("POST", `/api/requests/${RQ1.id}/offers`, { price: 600000, eta: "Same day", warrantyDays: 30, message: "Clean unit" });
  t("vendor offer → 201", r.status === 201 && r.json.data.request.myOffer.price === 600000, J(r.json));
  r = await C.v2.req("POST", `/api/requests/${RQ1.id}/offers`, { price: 580000 });
  await sleep(300);
  const offerEmails = emails().slice(emailsBeforeOffers).filter((e) => e.body.to[0].email === "cust@t.com");
  t("customer emailed for first offer only (second in-app)", offerEmails.length === 1 && (await notesFor("cust@t.com", "offer_received")).length === 2, offerEmails.length);
  r = await C.cust.req("GET", `/api/requests/${RQ1.id}`);
  let offers = r.json.data.request.offers;
  t("customer sees offers best-first, recommended flagged, no contacts", offers.length === 2 && offers[0].vendorName === "Nationwide Gadgets" && offers[0].recommended && !offers[1].recommended && !J(r.json).includes("+234"), J(offers));
  r = await C.v1.req("GET", `/api/requests/${RQ1.id}`);
  t("vendor sees only own offer + count (blind bidding)", r.json.data.request.offerCount === 2 && r.json.data.request.myOffer.price === 600000 && !r.json.data.request.offers && r.json.data.request.customerName === "Sade", J(r.json.data.request));
  r = await C.v1.req("POST", `/api/requests/${RQ1.id}/offers`, { price: 570000, eta: "Same day" });
  t("vendor updates offer (200)", r.status === 200);
  r = await C.cust.req("GET", `/api/requests/${RQ1.id}`);
  t("ranking follows the update", r.json.data.request.offers[0].vendorName === "Ade Phones");
  r = await C.v2.req("DELETE", `/api/requests/${RQ1.id}/offers`);
  r = await C.cust.req("GET", `/api/requests/${RQ1.id}`);
  t("withdrawn offer disappears", r.json.data.request.offers.length === 1);
  await C.v2.req("POST", `/api/requests/${RQ1.id}/offers`, { price: 590000 });
  r = await C.v1.req("GET", "/api/requests/for-vendor");
  t("vendor feed lists matched open requests", r.json.data.requests.length === 1 && r.json.data.requests[0].myOffer);
  r = await C.cust.req("GET", `/api/requests/${RQ1.id}`);
  const winner = r.json.data.request.offers.find((o) => o.vendorName === "Ade Phones");
  r = await C.john.req("POST", `/api/requests/${RQ1.id}/offers/${winner.id}/accept`);
  t("only the customer can accept", r.status === 404);
  r = await C.cust.req("POST", `/api/requests/${RQ1.id}/offers/${winner.id}/accept`);
  t("accept → accepted + WhatsApp link to TechNest", r.status === 200 && r.json.data.request.status === "accepted" && r.json.data.request.whatsappUrl.includes(RQ1.reference), J(r.json));
  r = await C.cust.req("POST", `/api/requests/${RQ1.id}/offers/${winner.id}/accept`);
  t("double accept → 409", r.status === 409);
  t("winner, loser and admins told", (await notesFor("v1@t.com", "offer_accepted")).length === 1 && (await notesFor("v2@t.com", "offer_update")).length === 1 && (await notesFor("admin@t.com", "admin_alert")).some((n) => n.message.includes("Ade Phones")));
  r = await C.v2.req("POST", `/api/requests/${RQ1.id}/offers`, { price: 1 });
  t("no offers after acceptance", r.status === 409);
  r = await C.admin.req("PATCH", `/api/admin/requests/${RQ1.id}`, { status: "completed" });
  t("admin completes", r.status === 200 && r.json.data.request.status === "completed");

  // Repair, stock ranking, no-match + match again
  r = await C.cust.req("POST", "/api/requests", { type: "repair", category: "phone", deviceName: "iPhone 12", issue: "Cracked screen", repairServiceId: "screen-replacement-oem", state: "Lagos" });
  t("repair request goes to repairers only", r.json.data.matchedVendors === 1 && String((await db.collection("devicerequests").findOne({ _id: oid(r.json.data.request.id) })).matchedVendors[0]) === String(ids.v4));
  r = await C.cust.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "Galaxy S23 Ultra", state: "Lagos" });
  const rqS = await db.collection("devicerequests").findOne({ _id: oid(r.json.data.request.id) });
  t("vendor holding the device in stock ranks above a local one", String(rqS.matchedVendors[0]) === String(ids.v2), J(rqS.matchedVendors));
  r = await C.cust.req("POST", "/api/requests", { type: "buy", category: "camera", deviceName: "Canon R50", state: "Kano" });
  const RQ3 = r.json.data.request;
  t("no matching vendor → 0 matched, admins alerted, customer told", r.json.data.matchedVendors === 0 && (await notesFor("admin@t.com", "admin_alert")).some((n) => n.title.includes(RQ3.reference)) && (await notesFor("cust@t.com", "device_request")).some((n) => /team will contact you/.test(n.message)));
  await users.updateOne({ _id: ids.v3 }, { $set: { "vendorProfile.vendorTypes": ["gadgets"], "vendorProfile.states": [] } });
  r = await C.admin.req("POST", `/api/admin/requests/${RQ3.id}/match`);
  t("admin 'match again' adds the newly suitable vendor", r.json.data.added === 1 && (await notesFor("v3@t.com", "device_request")).length === 1, J(r.json));
  r = await C.admin.req("GET", "/api/admin/requests?unmatched=true");
  t("admin unmatched filter", r.json.data.requests.every((x) => x.matchedVendors === 0));

  // Sell + stolen IMEI
  await C.cust.req("POST", "/api/imei/stolen-reports", { imei: "353911101234566", brand: "Samsung", model: "Galaxy S21", policeStation: "Ikeja", policeReportUrl: `https://res.cloudinary.com/${CLOUD}/image/upload/p.pdf` });
  r = await C.seller.req("POST", "/api/requests", { type: "sell", category: "phone", deviceName: "Galaxy S21", imei: "353911101234566", state: "Lagos" });
  t("sell request with stolen IMEI → 409", r.status === 409);
  r = await C.seller.req("POST", "/api/requests", { type: "sell", category: "phone", deviceName: "iPhone 12", imei: "490154203237518", condition: "UK used, 85% battery", snapchatStatus: "works", state: "Lagos" });
  const RQS = r.json.data.request;
  t("sell request ok, IMEI last 4 only", r.status === 201 && RQS.imeiLast4 === "7518" && RQS.snapchatStatus === "works");
  await C.v1.req("POST", `/api/requests/${RQS.id}/offers`, { price: 300000 });
  await C.v2.req("POST", `/api/requests/${RQS.id}/offers`, { price: 320000 });
  r = await C.seller.req("GET", `/api/requests/${RQS.id}`);
  t("sell requests: highest offer recommended; completed deals shown", r.json.data.request.offers[0].price === 320000 && r.json.data.request.offers.find((o) => o.vendorName === "Ade Phones").vendorCompletedDeals === 1, J(r.json.data.request.offers));

  // Auto-select via tick; lazy expiry; cancel
  r = await C.cust.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "iPhone 13 Pro", state: "Lagos", autoSelect: true, hours: 2 });
  const RQA = r.json.data.request;
  await C.v1.req("POST", `/api/requests/${RQA.id}/offers`, { price: 610000 });
  await C.v2.req("POST", `/api/requests/${RQA.id}/offers`, { price: 600000 });
  r = await C.cust.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "Pixel 8", state: "Lagos" });
  const RQE = r.json.data.request;
  await db.collection("devicerequests").updateMany({ _id: { $in: [oid(RQA.id), oid(RQE.id)] } }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  r = await guest.req("POST", "/api/internal/tick", null, { "X-Cron-Secret": "wrong" });
  t("tick needs the secret", r.status === 401);
  r = await guest.req("POST", "/api/internal/tick", null, { "X-Cron-Secret": "cron-secret-123" });
  t("tick closes due requests", r.status === 200 && r.json.data.requestsClosed === 2, J(r.json));
  const rqa = await db.collection("devicerequests").findOne({ _id: oid(RQA.id) });
  t("autoSelect picked the best offer", rqa.status === "accepted" && rqa.autoSelected && String(rqa.acceptedVendor) === String(ids.v2), J({ s: rqa.status, v: rqa.acceptedVendor }));
  t("customer told we picked for them", (await notesFor("cust@t.com", "device_request")).some((n) => /picked the best offer/.test(n.title)));
  t("request without autoSelect expired", (await db.collection("devicerequests").findOne({ _id: oid(RQE.id) })).status === "expired");
  r = await C.cust.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "Pixel 9", state: "Lagos" });
  const RQL = r.json.data.request;
  await db.collection("devicerequests").updateOne({ _id: oid(RQL.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  r = await C.cust.req("GET", `/api/requests/${RQL.id}`);
  t("expiry also applied when read (no cron needed)", r.json.data.request.status === "expired");
  r = await C.cust.req("POST", "/api/requests", { type: "buy", category: "phone", deviceName: "Pixel 7", state: "Lagos" });
  const RQC = r.json.data.request;
  await C.v1.req("POST", `/api/requests/${RQC.id}/offers`, { price: 100 });
  r = await C.cust.req("POST", `/api/requests/${RQC.id}/cancel`);
  t("customer cancels; vendor who offered told", r.status === 200 && (await notesFor("v1@t.com", "offer_update")).some((n) => /cancelled/.test(n.title)));

  // ── #8 Announcements ──────────────────────────────────────────────────
  r = await C.admin.req("POST", "/api/admin/announcements", { audience: "approved_vendors", title: "Update your profile", message: "x", dryRun: true });
  t("announcement dry run counts approved vendors", r.json.data.recipients === 4, J(r.json));
  const be = emails().length;
  r = await C.admin.req("POST", "/api/admin/announcements", { audience: "all_vendors", title: "New: customer requests", message: "You can now receive customer requests.\n\nComplete your vendor profile to get matched.", sendEmail: true });
  await sleep(800);
  t("announcement sent in-app to all vendors", r.status === 201 && r.json.data.recipients === 5 && (await notes.countDocuments({ type: "announcement" })) === 5, J(r.json));
  const annEmails = emails().slice(be).filter((e) => e.body.subject === "New: customer requests");
  t("announcement emails sent with paragraphs", annEmails.length === 5 && annEmails[0].body.textContent.includes("Complete your vendor profile"));
  r = await C.admin.req("GET", "/api/admin/announcements");
  t("announcement progress recorded", r.json.data.announcements[0].emailsSent === 5);
  r = await C.v1.req("POST", "/api/admin/announcements", { audience: "everyone", title: "x", message: "y" });
  t("non-admin can't announce", r.status === 403);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) console.log(log.split("\n").filter((l) => /Error|error/.test(l)).slice(-10).join("\n"));
  server.kill(); await mongoose.disconnect(); await mongo.stop();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
