const express = require("express");
const { sendSuccess, sendError } = require("../utils/response");
const {
  calculateValuation,
  getDevices,
  getAllDevices,
  getMeta,
} = require("../utils/valuation");
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
 *       so the UI can show why the price is what it is. `min`/`max` are ±3%
 *       around the valued price; `value` is the midpoint used for swaps.
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
 *         description: Unknown device or missing custom price
 */
router.post("/estimate", (req, res) => {
  const result = calculateValuation(req.body || {});
  if (!result)
    return sendError(
      res,
      400,
      "We couldn't value that device — pick one from the list or enter a price."
    );

  sendSuccess(res, 200, "Valuation computed", {
    valuation: {
      deviceId: result.deviceId,
      deviceName: result.deviceName,
      storage: result.deviceStorage,
      isCustom: result.isCustom,
      basePrice: result.basePrice,
      breakdown: result.breakdown,
      deductionPercent: result.deductionPercent,
      min: result.minVal,
      max: result.maxVal,
      value: Math.round((result.minVal + result.maxVal) / 2),
    },
  });
});

module.exports = router;
