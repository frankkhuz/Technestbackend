const express = require("express");
const { sendSuccess, sendError } = require("../utils/response");
const {
  FAULT_IDS,
  FAULTS,
  COSMETIC,
  calculateValuation,
  getDevices,
  getAllDevices,
  getMeta,
} = require("../utils/valuation");
const { parseImei, compareModel } = require("../utils/imei");
const router = express.Router();

const SUBTYPES = {
  phone: ["iphone", "android"],
  laptop: ["macbook", "windows", "linux", "gaming"],
};

const shape = (d) => ({
  id: d.id,
  name: d.name,
  storage: d.storage,
  baseMin: d.baseMin,
  baseMax: d.baseMax,
  ram: d.ram,
  chip: d.chip,
  display: d.display,
  priceSource: d.priceSource || "legacy",
  basis: d.basis,
});

/**
 * @swagger
 * /api/valuation/devices:
 *   get:
 *     summary: Devices the valuation engine knows, with their base (best-condition) prices
 *     description: >
 *       Replaces the frontend's hardcoded iphoneDevices / androidDevices /
 *       laptopDevices tables. Use the returned `id` as `deviceId` in
 *       /api/valuation/estimate and swap offers. Without query params, returns
 *       every table. `priceSource` is "market" when the price comes from a
 *       dealer price list (see `sources`), "legacy" otherwise.
 *     tags: [Valuation]
 *     parameters:
 *       - in: query
 *         name: category
 *         schema: { type: string, enum: [phone, laptop] }
 *       - in: query
 *         name: subType
 *         schema: { type: string, enum: [iphone, android, macbook, windows, linux, gaming] }
 *     responses:
 *       200:
 *         description: Devices fetched
 */
router.get("/devices", (req, res) => {
  const { category, subType } = req.query;
  const meta = getMeta();
  const devices = getAllDevices();

  if (category || subType) {
    if (!SUBTYPES[category] || !SUBTYPES[category].includes(subType))
      return sendError(res, 400, "Pass a valid category and subType together");
    return sendSuccess(res, 200, "Devices fetched", {
      devices: getDevices(category, subType).map(shape),
      ...meta,
    });
  }

  sendSuccess(res, 200, "Devices fetched", {
    devices: {
      phone: {
        iphone: devices.iphone.map(shape),
        android: devices.android.map(shape),
      },
      laptop: Object.fromEntries(
        SUBTYPES.laptop.map((s) => [s, (devices.laptop[s] || []).map(shape)])
      ),
    },
    ...meta,
  });
});

/**
 * @swagger
 * /api/valuation/estimate:
 *   post:
 *     summary: Value a device from its condition report
 *     description: >
 *       The same engine used for swap offers. Returns the itemised deductions
 *       (each with a naira `amount`) so the UI can show why the price is what
 *       it is. `min`/`max` are ±3% around the valued price; `value` is the
 *       midpoint used for swaps. `confidence` (high / medium / low, with a
 *       reason) and `likelyRange` say how sure we are. Optional extras:
 *       `cosmeticGrade`, `faults` (ids from GET /api/valuation/conditions —
 *       fixable faults are priced from the repair list), `snapchatStatus`,
 *       `batteryCycleCount` (laptops), `accountLocked` (true = refused), and
 *       `imei` (warns if it belongs to a different model).
 *     tags: [Valuation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/OfferedDevice' }
 *     responses:
 *       200:
 *         description: Valuation computed
 *       400:
 *         description: Unknown device, missing custom price, or device locked to an account
 */
router.post("/estimate", async (req, res, next) => {
  try {
    const result = calculateValuation(req.body || {});
    if (!result)
      return sendError(
        res,
        400,
        "We couldn't value that device — pick one from the list or enter a price."
      );
    if (result.blocked) return sendError(res, 400, result.blocked);

    // The IMEI's first 8 digits say what model it really is. Only the model
    // check runs here — stolen checks have their own rate-limited endpoint.
    const warnings = [];
    if (req.body.imei) {
      const parsed = parseImei(req.body.imei);
      if (parsed.error) warnings.push(parsed.error);
      else {
        const check = await compareModel(parsed.tac, result.deviceName);
        if (check.modelMatch === "mismatch")
          warnings.push(`This IMEI belongs to a ${check.tacBrand} ${check.tacModel}, not a ${result.deviceName}. Check you picked the right model.`);
      }
    }

    sendSuccess(res, 200, "Valuation computed", {
      valuation: {
        deviceId: result.deviceId,
        deviceName: result.deviceName,
        storage: result.deviceStorage,
        isCustom: result.isCustom,
        basePrice: result.basePrice,
        breakdown: result.breakdown,
        deductionPercent: result.deductionPercent,
        repairDeduction: result.repairDeduction,
        // true when condition deductions hit the 65% cap
        deductionCapped: result.deductionCapped,
        min: result.minVal,
        max: result.maxVal,
        value: Math.round((result.minVal + result.maxVal) / 2),
        confidence: result.confidence,
        likelyRange: result.likelyRange,
        pricedAt: result.pricedAt,
        warnings,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/valuation/conditions:
 *   get:
 *     summary: Options for the condition form — faults and cosmetic grades
 *     description: Show `faults` as checkboxes ("What's not working?") filtered by `appliesTo`, and `cosmeticGrades` as a single choice.
 *     tags: [Valuation]
 *     security: []
 *     responses:
 *       200:
 *         description: "data: { faults: [{ id, label, appliesTo }], cosmeticGrades: [{ id, label }] }"
 */
router.get("/conditions", (req, res) => {
  sendSuccess(res, 200, "Condition options", {
    faults: FAULT_IDS.map((id) => {
      const f = FAULTS[id];
      const appliesTo = f.repair ? Object.keys(f.repair) : f.phoneOnly ? ["phone"] : ["phone", "laptop"];
      return { id, label: f.label, appliesTo };
    }),
    cosmeticGrades: [
      { id: "like_new", label: "Like new — no visible marks" },
      ...Object.entries(COSMETIC).filter(([, v]) => v).map(([id, v]) => ({ id, label: v.label })),
    ],
  });
});

module.exports = router;
