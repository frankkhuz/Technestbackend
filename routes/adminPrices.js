const express = require("express");
const ValuationDevice = require("../models/ValuationDevice");
const Product = require("../models/Product");
const AppSetting = require("../models/AppSetting");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { reloadDevices } = require("../utils/valuation");
const { parsePriceList } = require("../utils/priceListParser");
const { normalizeDeviceName, escapeRegex } = require("../utils/textParsing");
const {
  basePriceFor,
  baseMinFor,
  round5k,
  CATALOG_MAP,
} = require("../utils/marketPricing");
const ai = require("../utils/ai");
const router = express.Router();

// Every route: logged-in admin
router.use(protect, restrictTo("admin"));

const SUBTYPES = {
  phone: ["iphone", "android"],
  laptop: ["macbook", "windows", "linux", "gaming"],
};
const SIMS = ["phys+esim", "esim", "dual-sim"];
const CONDITIONS = ["uk-used", "new"];

const getSettings = async () => {
  const rows = await AppSetting.find({ key: { $in: ["prices.strategy", "prices.catalogMarkup"] } });
  const get = (k, d) => rows.find((r) => r.key === k)?.value ?? d;
  return {
    strategy: get("prices.strategy", "avg"),
    catalogMarkup: Number(get("prices.catalogMarkup", 0)),
  };
};

const recompute = (doc, strategy) => {
  if (doc.priceSource === "manual") return;
  const base = basePriceFor(doc.quotes, strategy);
  if (!base) return;
  doc.baseMax = base.price;
  doc.baseMin = baseMinFor(base.price);
  doc.basis = base.basis;
  doc.priceSource = "market";
};

const slugify = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\+/g, " plus ")
    .replace(/\b(samsung|galaxy|google)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const newDeviceId = async (name, storage) => {
  const base = [slugify(name), slugify(String(storage || "").replace(/gb$/i, ""))]
    .filter(Boolean)
    .join("-")
    .slice(0, 70);
  let id = base;
  for (let i = 2; await ValuationDevice.exists({ deviceId: id }); i++) id = `${base}-${i}`;
  return id;
};

// ── Browse & edit by hand ────────────────────────────────────────────────────

/**
 * @swagger
 * /api/admin/prices/devices:
 *   get:
 *     summary: Valuation devices with their dealer quotes (admin)
 *     tags: [Admin — Prices]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string, enum: [phone, laptop] }
 *       - in: query
 *         name: subType
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: includeInactive
 *         schema: { type: boolean }
 *     responses:
 *       200:
 *         description: data.devices (each with quotes[]), data.settings
 *   post:
 *     summary: Add a device by hand (admin)
 *     tags: [Admin — Prices]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [category, subType, name, baseMax]
 *             properties:
 *               category: { type: string, enum: [phone, laptop] }
 *               subType: { type: string, enum: [iphone, android, macbook, windows, linux, gaming] }
 *               name: { type: string, example: Samsung S25 }
 *               storage: { type: string, example: 256GB }
 *               baseMax: { type: number, description: Best-condition price in naira }
 *     responses:
 *       201:
 *         description: Device created
 */
router.get("/devices", async (req, res, next) => {
  try {
    const { category, subType, q, includeInactive } = req.query;
    const filter = {};
    if (includeInactive !== "true") filter.isActive = true;
    if (SUBTYPES[category]) filter.category = category;
    if (typeof subType === "string" && subType) filter.subType = subType;
    if (typeof q === "string" && q.trim())
      filter.name = new RegExp(escapeRegex(q.trim().slice(0, 60)), "i");

    const devices = await ValuationDevice.find(filter).sort({ subType: 1, baseMax: -1 });
    sendSuccess(res, 200, "Devices fetched", {
      devices: devices.map((d) => d.toClient({ withQuotes: true })),
      settings: await getSettings(),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/devices", verifyCsrfToken, async (req, res, next) => {
  try {
    const { category, subType, name, storage = "" } = req.body;
    const baseMax = Number(req.body.baseMax);
    if (!SUBTYPES[category]?.includes(subType) || !name || !(baseMax > 0))
      return sendError(res, 400, "category, subType, name and a positive baseMax are required");

    const device = await ValuationDevice.create({
      deviceId: await newDeviceId(name, storage),
      category,
      subType,
      name: String(name).trim(),
      storage: String(storage).trim(),
      baseMax: round5k(baseMax),
      baseMin: baseMinFor(round5k(baseMax)),
      priceSource: "manual",
    });
    await reloadDevices();
    sendSuccess(res, 201, "Device created", { device: device.toClient({ withQuotes: true }) });
  } catch (err) {
    if (err.name === "ValidationError") return sendError(res, 400, err.message);
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/prices/devices/{deviceId}:
 *   patch:
 *     summary: Edit a device by hand (admin)
 *     description: >
 *       Setting `baseMax` pins a manual price (dealer quotes are then ignored
 *       for this device). Send `useQuotes: true` to go back to the price
 *       computed from quotes. `isActive: false` hides it from the device lists.
 *     tags: [Admin — Prices]
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               storage: { type: string }
 *               baseMax: { type: number }
 *               useQuotes: { type: boolean }
 *               isActive: { type: boolean }
 *     responses:
 *       200:
 *         description: Device updated
 */
router.patch("/devices/:deviceId", verifyCsrfToken, async (req, res, next) => {
  try {
    const device = await ValuationDevice.findOne({ deviceId: req.params.deviceId });
    if (!device) return sendError(res, 404, "Device not found");
    const { name, storage, baseMax, useQuotes, isActive } = req.body;

    if (typeof name === "string" && name.trim()) device.name = name.trim();
    if (typeof storage === "string") device.storage = storage.trim();
    if (typeof isActive === "boolean") device.isActive = isActive;
    if (baseMax !== undefined) {
      if (!(Number(baseMax) > 0)) return sendError(res, 400, "baseMax must be a positive number");
      device.baseMax = round5k(Number(baseMax));
      device.baseMin = baseMinFor(device.baseMax);
      device.priceSource = "manual";
      device.basis = null;
    } else if (useQuotes === true) {
      if (!device.quotes.length) return sendError(res, 400, "This device has no dealer quotes to use");
      device.priceSource = "market";
      recompute(device, (await getSettings()).strategy);
    }

    await device.save();
    await reloadDevices();
    sendSuccess(res, 200, "Device updated", { device: device.toClient({ withQuotes: true }) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/prices/devices/{deviceId}/quotes/{quoteId}:
 *   delete:
 *     summary: Remove one dealer quote from a device (admin)
 *     tags: [Admin — Prices]
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: quoteId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Quote removed and price recomputed
 */
router.delete("/devices/:deviceId/quotes/:quoteId", verifyCsrfToken, async (req, res, next) => {
  try {
    const device = await ValuationDevice.findOne({ deviceId: req.params.deviceId });
    if (!device) return sendError(res, 404, "Device not found");
    const quote = device.quotes.id(req.params.quoteId);
    if (!quote) return sendError(res, 404, "Quote not found");
    quote.deleteOne();
    recompute(device, (await getSettings()).strategy);
    await device.save();
    await reloadDevices();
    sendSuccess(res, 200, "Quote removed", { device: device.toClient({ withQuotes: true }) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/prices/settings:
 *   patch:
 *     summary: How quotes combine, and the catalog markup (admin)
 *     tags: [Admin — Prices]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               strategy: { type: string, enum: [avg, min, max], description: How quotes from several dealers are combined }
 *               catalogMarkup: { type: number, description: "% added on top of the valuation price for /buy catalog selling prices" }
 *     responses:
 *       200:
 *         description: Settings saved
 */
router.patch("/settings", verifyCsrfToken, async (req, res, next) => {
  try {
    const { strategy, catalogMarkup } = req.body;
    if (strategy !== undefined) {
      if (!["avg", "min", "max"].includes(strategy))
        return sendError(res, 400, "strategy must be avg, min or max");
      await AppSetting.findOneAndUpdate({ key: "prices.strategy" }, { key: "prices.strategy", value: strategy }, { upsert: true });
    }
    if (catalogMarkup !== undefined) {
      const m = Number(catalogMarkup);
      if (!Number.isFinite(m) || m < 0 || m > 100)
        return sendError(res, 400, "catalogMarkup must be between 0 and 100");
      await AppSetting.findOneAndUpdate({ key: "prices.catalogMarkup" }, { key: "prices.catalogMarkup", value: m }, { upsert: true });
    }
    sendSuccess(res, 200, "Settings saved", { settings: await getSettings() });
  } catch (err) {
    next(err);
  }
});

// ── Paste a dealer list: read it (AI or rules), preview, apply ──────────────

const PARSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          line: { type: "string" },
          deviceId: { type: "string", description: "Exact id from the device list, or empty string if no clear match" },
          name: { type: "string" },
          storage: { type: "string" },
          price: { type: "integer", description: "Naira" },
          sim: { type: "string", enum: SIMS },
          condition: { type: "string", enum: CONDITIONS },
          note: { type: "string" },
        },
        required: ["line", "deviceId", "name", "storage", "price", "sim", "condition", "note"],
      },
    },
    ignored: { type: "array", items: { type: "string" } },
  },
  required: ["rows", "ignored"],
};

const parseWithAi = async (text, devices) => {
  const system = `You read Nigerian gadget dealer price lists (usually pasted from WhatsApp) and turn them into structured price quotes for TechNest's valuation engine.

For every line that quotes a price for a device:
- price: whole naira. "185k" = 185000, "N1.650M" = 1650000, "1,120,000" = 1120000. In a list quoted in thousands, a bare "=1.090" means 1,090,000. If a line gives two prices ("N1.830M | N1.850M"), use their average and say so in note.
- deviceId: the exact id from the device list below when the line is clearly the same model AND storage. Headers apply to the lines under them (e.g. "USED IPHONES" then "14 PRO 128GB" means iPhone 14 Pro 128GB). If the storage isn't stated and the model has several storage options, or you're not sure, use "".
- name / storage: the model and storage as written, cleaned up (e.g. "Samsung S22 Ultra", "256GB").
- sim: "phys+esim" for physical SIM + eSIM (also "1sim + esim", "PHY+ESIM", or when a header says the whole list is physical + eSIM), "esim" for eSIM-only, "dual-sim" for dual physical SIM. A header like "ESIM UNLOCKED" applies to the lines below it.
- condition: "new" only when the line or its header says new; otherwise "uk-used".
- note: anything that makes this a special case (one-off unit, "FU", display message, cosmetic issues), else "".
Put headers, greetings and promo text in "ignored".

Known devices (JSON):
${JSON.stringify(devices.map((d) => ({ id: d.deviceId, name: d.name, storage: d.storage })))}`;

  const result = await ai.run({
    feature: "price_list_parse",
    system,
    messages: [{ role: "user", content: text }],
    schema: PARSE_SCHEMA,
    effort: "medium",
  });
  if (!result.ok) return result;

  // Trust but verify: ids must exist, prices must be sane
  const ids = new Set(devices.map((d) => d.deviceId));
  const byName = new Map();
  for (const d of devices) {
    const k = normalizeDeviceName(d.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ id: d.deviceId, name: d.name, storage: d.storage });
  }
  const rows = result.data.rows
    .filter((r) => Number.isInteger(r.price) && r.price >= 5000 && r.price <= 50_000_000)
    .map((r) => {
      const deviceId = ids.has(r.deviceId) ? r.deviceId : null;
      const d = deviceId ? devices.find((x) => x.deviceId === deviceId) : null;
      const candidates = deviceId ? undefined : byName.get(normalizeDeviceName(r.name));
      return {
        line: r.line,
        name: r.name,
        storage: r.storage || null,
        price: r.price,
        sim: r.sim,
        condition: r.condition,
        note: r.note || undefined,
        deviceId,
        matchedName: d ? `${d.name} ${d.storage}`.trim() : null,
        candidates: candidates?.length ? candidates : undefined,
      };
    });
  return { ok: true, rows, ignored: result.data.ignored };
};

/**
 * @swagger
 * /api/admin/prices/parse:
 *   post:
 *     summary: Read a pasted dealer price list into rows to review (admin)
 *     description: >
 *       Uses AI when it's available, otherwise (or with `method: "rules"`) the
 *       free built-in reader. Nothing is saved — review the rows (fix
 *       deviceId where it's null, untick anything wrong), then send them to
 *       /preview and /apply. `source` says which reader ran; `aiReason` says
 *       why AI wasn't used.
 *     tags: [Admin — Prices]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text]
 *             properties:
 *               text: { type: string, description: The pasted list }
 *               method: { type: string, enum: [auto, rules], default: auto }
 *     responses:
 *       200:
 *         description: data.rows, data.ignored, data.source (ai | rules), data.aiReason
 */
router.post("/parse", verifyCsrfToken, async (req, res, next) => {
  try {
    const text = typeof req.body.text === "string" ? req.body.text.slice(0, 20000) : "";
    if (!text.trim()) return sendError(res, 400, "Paste a price list in `text`");

    const devices = await ValuationDevice.find({ isActive: true, category: "phone" });
    let aiReason = null;

    if (req.body.method !== "rules") {
      const result = await parseWithAi(text, devices);
      if (result.ok)
        return sendSuccess(res, 200, "Price list read", {
          source: "ai",
          rows: result.rows,
          ignored: result.ignored,
        });
      aiReason = result.reason;
    }

    const parsed = parsePriceList(
      text,
      devices.map((d) => ({ id: d.deviceId, name: d.name, storage: d.storage }))
    );
    sendSuccess(res, 200, "Price list read", {
      source: "rules",
      aiReason: aiReason || undefined,
      rows: parsed.rows,
      ignored: parsed.ignored,
    });
  } catch (err) {
    next(err);
  }
});

// Validate rows and work out every change they'd cause, without saving
const planChanges = async (body) => {
  const sourceName = String(body.sourceName || "").trim().slice(0, 100);
  if (!sourceName) return { error: "sourceName is required (e.g. \"Skyygadget – 27 Sep\")" };
  if (!Array.isArray(body.rows) || !body.rows.length) return { error: "rows must be a non-empty array" };
  if (body.rows.length > 500) return { error: "Too many rows (max 500)" };

  const replaceSource = body.replaceSource !== false;
  const { strategy, catalogMarkup } = await getSettings();

  const devices = new Map();
  const newDevices = [];
  for (const [i, r] of body.rows.entries()) {
    const price = Number(r.price);
    if (!(price >= 5000 && price <= 50_000_000)) return { error: `Row ${i + 1}: price must be between ₦5,000 and ₦50,000,000` };
    if (r.sim && !SIMS.includes(r.sim)) return { error: `Row ${i + 1}: sim must be one of ${SIMS.join(", ")}` };
    if (r.condition && !CONDITIONS.includes(r.condition)) return { error: `Row ${i + 1}: condition must be uk-used or new` };

    let doc;
    if (r.deviceId) {
      doc = devices.get(r.deviceId) || (await ValuationDevice.findOne({ deviceId: r.deviceId }));
      if (!doc) return { error: `Row ${i + 1}: unknown deviceId "${r.deviceId}"` };
    } else if (r.newDevice) {
      const { category = "phone", subType, name, storage = "" } = r.newDevice;
      if (!SUBTYPES[category]?.includes(subType) || !name)
        return { error: `Row ${i + 1}: newDevice needs category, subType and name` };
      const key = `new:${subType}:${normalizeDeviceName(name)}:${storage}`;
      doc = devices.get(key);
      if (!doc) {
        doc = new ValuationDevice({
          deviceId: await newDeviceId(name, storage),
          category,
          subType,
          name: String(name).trim(),
          storage: String(storage).trim(),
          baseMax: 0,
          baseMin: 0,
          priceSource: "market",
        });
        newDevices.push(doc);
        devices.set(key, doc);
      }
    } else {
      return { error: `Row ${i + 1}: pick a device (deviceId) or describe a newDevice` };
    }
    if (!devices.has(doc.deviceId)) {
      doc._before = { baseMax: doc.baseMax, priceSource: doc.priceSource };
      if (replaceSource) doc.quotes = doc.quotes.filter((q) => q.source !== sourceName);
      devices.set(doc.deviceId, doc);
    }
    doc.quotes.push({
      source: sourceName,
      price: Math.round(price),
      sim: r.sim || "phys+esim",
      condition: r.condition || "uk-used",
      note: typeof r.note === "string" ? r.note.slice(0, 200) : null,
    });
  }

  const unique = [...new Set(devices.values())];
  const deviceChanges = [];
  for (const doc of unique) {
    recompute(doc, strategy);
    deviceChanges.push({
      deviceId: doc.deviceId,
      name: `${doc.name} ${doc.storage}`.trim(),
      isNew: doc.isNew,
      before: doc._before?.baseMax ?? null,
      after: doc.baseMax,
      basis: doc.basis,
      manualPriceKept: doc.priceSource === "manual",
    });
  }

  // Catalog selling prices that follow these devices
  const catalogChanges = [];
  const slugsByDevice = Object.entries(CATALOG_MAP).filter(([, id]) => devices.has(id));
  const products = await Product.find({ slug: { $in: slugsByDevice.map(([s]) => s) } });
  for (const [slug, id] of slugsByDevice) {
    const doc = devices.get(id);
    const product = products.find((p) => p.slug === slug);
    if (!product || doc.priceSource !== "market" || doc.basis === "new") continue;
    const price = round5k(doc.baseMax * (1 + catalogMarkup / 100));
    if (price !== product.priceUkUsed)
      catalogChanges.push({ slug, name: product.name, before: product.priceUkUsed, after: price, product });
  }

  return { sourceName, devices: unique, deviceChanges, catalogChanges };
};

const summary = (plan) => ({
  sourceName: plan.sourceName,
  devices: plan.deviceChanges,
  catalog: plan.catalogChanges.map(({ product, ...c }) => c),
});

/**
 * @swagger
 * components:
 *   schemas:
 *     PriceRowsInput:
 *       type: object
 *       required: [sourceName, rows]
 *       properties:
 *         sourceName: { type: string, example: "Skyygadget – 27 Sep" }
 *         replaceSource: { type: boolean, default: true, description: "Replace this source's older quotes on the same devices" }
 *         updateCatalog: { type: boolean, default: true, description: "apply only — also update /buy catalog UK-used prices" }
 *         rows:
 *           type: array
 *           items:
 *             type: object
 *             required: [price]
 *             properties:
 *               deviceId: { type: string }
 *               newDevice:
 *                 type: object
 *                 properties:
 *                   category: { type: string, enum: [phone, laptop] }
 *                   subType: { type: string }
 *                   name: { type: string }
 *                   storage: { type: string }
 *               price: { type: number }
 *               sim: { type: string, enum: [phys+esim, esim, dual-sim] }
 *               condition: { type: string, enum: [uk-used, new] }
 *               note: { type: string }
 * /api/admin/prices/preview:
 *   post:
 *     summary: Show what applying these rows would change — nothing is saved (admin)
 *     tags: [Admin — Prices]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PriceRowsInput' }
 *     responses:
 *       200:
 *         description: data.devices (before → after), data.catalog (before → after)
 * /api/admin/prices/apply:
 *   post:
 *     summary: Save the rows as dealer quotes and update prices (admin)
 *     tags: [Admin — Prices]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/PriceRowsInput' }
 *     responses:
 *       200:
 *         description: Same shape as preview, after saving
 */
router.post("/preview", verifyCsrfToken, async (req, res, next) => {
  try {
    const plan = await planChanges(req.body);
    if (plan.error) return sendError(res, 400, plan.error);
    sendSuccess(res, 200, "Preview ready", summary(plan));
  } catch (err) {
    next(err);
  }
});

router.post("/apply", verifyCsrfToken, async (req, res, next) => {
  try {
    const plan = await planChanges(req.body);
    if (plan.error) return sendError(res, 400, plan.error);

    for (const doc of plan.devices) await doc.save();
    if (req.body.updateCatalog !== false)
      for (const c of plan.catalogChanges) {
        c.product.priceUkUsed = c.after;
        await c.product.save();
      }
    await reloadDevices();

    const out = summary(plan);
    if (req.body.updateCatalog === false) out.catalog = [];
    sendSuccess(res, 200, "Prices updated", out);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
