const express = require("express");
const mongoose = require("mongoose");
const Listing = require("../models/Listing");
const StolenReport = require("../models/StolenReport");
const TacDevice = require("../models/TacDevice");
const Transaction = require("../models/Transaction");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { parseTacCsv, importTacRows, OPEN_LISTING_STATUSES } = require("../utils/imei");
const { notify } = require("../utils/notify");
const router = express.Router();

// Every route below requires a logged-in admin
router.use(protect, restrictTo("admin"));

/**
 * @swagger
 * /api/admin/imei/stolen-reports:
 *   get:
 *     summary: Stolen-device reports to review
 *     tags: [Admin IMEI]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, confirmed, rejected, recovered], default: pending }
 *     responses:
 *       200:
 *         description: data.reports — each with reporter { name, email } and the latest hits
 */
router.get("/stolen-reports", async (req, res, next) => {
  try {
    const status = req.query.status || "pending";
    const reports = await StolenReport.find({ status })
      .populate("reporter", "name email")
      .populate("hits.user", "name email")
      .sort({ createdAt: -1 })
      .limit(200);
    sendSuccess(res, 200, "Reports fetched", { reports });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/imei/stolen-reports/{id}:
 *   patch:
 *     summary: Confirm, reject or close a stolen-device report
 *     description: >
 *       Confirming takes down any open listing with that IMEI and cancels its
 *       open swap/buy requests. The reporter is notified of every decision.
 *     tags: [Admin IMEI]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [confirmed, rejected, recovered] }
 *               reviewNotes: { type: string, maxLength: 500 }
 *     responses:
 *       200:
 *         description: data.report, data.listingsRemoved
 */
router.patch("/stolen-reports/:id", verifyCsrfToken, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["confirmed", "rejected", "recovered"].includes(status))
      return sendError(res, 400, "status must be confirmed, rejected or recovered");
    if (!mongoose.isValidObjectId(req.params.id))
      return sendError(res, 404, "Report not found");

    const report = await StolenReport.findById(req.params.id).select("+imeiHash");
    if (!report) return sendError(res, 404, "Report not found");

    report.status = status;
    report.reviewNotes =
      typeof req.body.reviewNotes === "string" ? req.body.reviewNotes.slice(0, 500) : null;
    report.reviewedBy = req.user._id;
    report.reviewedAt = new Date();
    await report.save();

    let listingsRemoved = 0;
    if (status === "confirmed") {
      const listings = await Listing.find({
        imeiHash: report.imeiHash,
        status: { $in: OPEN_LISTING_STATUSES },
      }).select("_id");
      const ids = listings.map((l) => l._id);
      if (ids.length) {
        await Listing.updateMany(
          { _id: { $in: ids } },
          { status: "removed", rejectionReason: "This device has been reported stolen." }
        );
        await Transaction.updateMany(
          { listing: { $in: ids }, status: { $in: ["pending", "accepted"] } },
          { status: "cancelled" }
        );
        listingsRemoved = ids.length;
      }
    }

    const outcome = {
      confirmed: "has been confirmed. Anyone who checks or tries to list this IMEI on TechNest will be blocked, and we'll tell you when it's seen.",
      rejected: `couldn't be confirmed${report.reviewNotes ? `: ${report.reviewNotes}` : "."}`,
      recovered: "has been closed as recovered.",
    }[status];
    await notify({
      recipient: report.reporter,
      type: "stolen_report_update",
      title: "Update on your stolen-device report",
      message: `Your report for the ${report.brand} ${report.model} (IMEI ending ${report.imeiLast4}) ${outcome}`.slice(0, 500),
    });

    const out = report.toObject();
    delete out.imeiHash;
    sendSuccess(res, 200, "Report updated", { report: out, listingsRemoved });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/imei/tac:
 *   get:
 *     summary: Search the TAC (IMEI model code) table
 *     tags: [Admin IMEI]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string, description: "TAC digits, brand or model" }
 *     responses:
 *       200:
 *         description: data.devices (max 300), data.total
 *   post:
 *     summary: Add or correct one TAC entry
 *     tags: [Admin IMEI]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tac, brand, model]
 *             properties:
 *               tac: { type: string, example: "35391110" }
 *               brand: { type: string, example: Apple }
 *               model: { type: string, example: iPhone 13 Pro }
 *               deviceType: { type: string, enum: [phone, tablet, wearable, other] }
 *               active: { type: boolean }
 *     responses:
 *       200:
 *         description: data.device
 */
router.get("/tac", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 50) : "";
    let filter = {};
    if (q) {
      const digits = q.replace(/\D/g, "");
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter = digits.length >= 3 && digits === q.replace(/\s/g, "")
        ? { tac: { $regex: `^${digits}` } }
        : { $or: [{ brand: { $regex: escaped, $options: "i" } }, { model: { $regex: escaped, $options: "i" } }] };
    }
    const [devices, total] = await Promise.all([
      TacDevice.find(filter).sort({ updatedAt: -1 }).limit(300),
      TacDevice.countDocuments(),
    ]);
    sendSuccess(res, 200, "TAC entries fetched", { devices, total });
  } catch (err) {
    next(err);
  }
});

router.post("/tac", verifyCsrfToken, async (req, res, next) => {
  try {
    const tac = String(req.body.tac || "").replace(/\D/g, "");
    const brand = String(req.body.brand || "").trim();
    const model = String(req.body.model || "").trim();
    if (tac.length !== 8) return sendError(res, 400, "The code must be exactly 8 digits.");
    if (!brand || !model) return sendError(res, 400, "Both the make and the model are needed.");

    const device = await TacDevice.findOneAndUpdate(
      { tac },
      {
        tac,
        brand,
        model,
        ...(req.body.deviceType ? { deviceType: req.body.deviceType } : {}),
        ...(typeof req.body.active === "boolean" ? { active: req.body.active } : {}),
        source: "manual",
        updatedBy: req.user._id,
      },
      { upsert: true, returnDocument: "after", runValidators: true }
    );
    sendSuccess(res, 200, "TAC entry saved", { device });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/imei/tac/import:
 *   post:
 *     summary: Bulk-add TAC entries from pasted CSV
 *     description: >
 *       One "tac,brand,model[,deviceType]" per line (comma, tab or
 *       semicolon). Requests are capped at 10kb (~250 lines) — use
 *       `node scripts/importTac.js <file.csv>` for big files. Entries an
 *       admin typed in by hand are not overwritten.
 *     tags: [Admin IMEI]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [csv]
 *             properties:
 *               csv: { type: string }
 *     responses:
 *       200:
 *         description: data.added, data.updated, data.skippedManual, data.problems
 */
router.post("/tac/import", verifyCsrfToken, async (req, res, next) => {
  try {
    const { rows, problems } = parseTacCsv(req.body.csv);
    if (!rows.length) return sendError(res, 400, "No valid lines found.", problems);
    const result = await importTacRows(rows, req.user._id);
    sendSuccess(res, 200, "TAC entries imported", { ...result, problems });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/imei/tac/unknown:
 *   get:
 *     summary: IMEI model codes seen on listings that aren't in the TAC table yet
 *     description: Fill these in so future listings with that code get checked.
 *     tags: [Admin IMEI]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: "data.codes: [{ tac, count, deviceNames, lastSeen }]"
 * /api/admin/imei/tac/mismatches:
 *   get:
 *     summary: Listings whose IMEI belongs to a different model than the seller typed
 *     description: Many mismatches on one code can also mean the TAC entry itself is wrong.
 *     tags: [Admin IMEI]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: "data.codes: [{ tac, tacBrand, tacModel, count, deviceNames, listingIds, lastSeen }]"
 */
router.get("/tac/unknown", async (req, res, next) => {
  try {
    const groups = await Listing.aggregate([
      { $match: { "imeiCheck.modelMatch": "unknown", imeiTac: { $type: "string" } } },
      {
        $group: {
          _id: "$imeiTac",
          count: { $sum: 1 },
          deviceNames: { $addToSet: "$deviceName" },
          lastSeen: { $max: "$createdAt" },
        },
      },
      { $sort: { count: -1, lastSeen: -1 } },
      { $limit: 300 },
    ]);
    // Codes added since those listings were checked are no longer unknown
    const known = new Set(
      (await TacDevice.find({ tac: { $in: groups.map((g) => g._id) } }).select("tac")).map((d) => d.tac)
    );
    const codes = groups
      .filter((g) => !known.has(g._id))
      .map((g) => ({ tac: g._id, count: g.count, deviceNames: g.deviceNames.slice(0, 5), lastSeen: g.lastSeen }));
    sendSuccess(res, 200, "Unknown codes fetched", { codes });
  } catch (err) {
    next(err);
  }
});

router.get("/tac/mismatches", async (req, res, next) => {
  try {
    const groups = await Listing.aggregate([
      { $match: { "imeiCheck.modelMatch": "mismatch" } },
      {
        $group: {
          _id: "$imeiTac",
          tacBrand: { $first: "$imeiCheck.tacBrand" },
          tacModel: { $first: "$imeiCheck.tacModel" },
          count: { $sum: 1 },
          deviceNames: { $addToSet: "$deviceName" },
          listingIds: { $push: "$_id" },
          lastSeen: { $max: "$createdAt" },
        },
      },
      { $sort: { lastSeen: -1 } },
      { $limit: 300 },
    ]);
    const codes = groups.map((g) => ({
      tac: g._id,
      tacBrand: g.tacBrand,
      tacModel: g.tacModel,
      count: g.count,
      deviceNames: g.deviceNames.slice(0, 5),
      listingIds: g.listingIds.slice(-20),
      lastSeen: g.lastSeen,
    }));
    sendSuccess(res, 200, "Mismatches fetched", { codes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
