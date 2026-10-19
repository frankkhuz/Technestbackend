const express = require("express");
const mongoose = require("mongoose");
const rateLimit = require("express-rate-limit");
const StolenReport = require("../models/StolenReport");
const { protect, optionalAuth, requireVerified } = require("../middleware/auth");
const { verifyCsrfToken, verifyCsrfIfAuthenticated } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const {
  parseImei,
  hashImei,
  compareModel,
  findOpenStolenReport,
  recordStolenHit,
} = require("../utils/imei");
const router = express.Router();

// Free for everyone, but tight enough that nobody can walk the IMEI space
// looking for reported devices
const checkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  handler: (req, res) =>
    sendError(res, 429, "Too many IMEI checks — please wait a few minutes."),
});

const isOurUpload = (url) =>
  typeof url === "string" &&
  url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`);

const toClient = (r) => ({
  id: String(r._id),
  imeiLast4: r.imeiLast4,
  brand: r.brand,
  model: r.model,
  incidentDate: r.incidentDate ? r.incidentDate.toISOString() : null,
  description: r.description,
  policeStation: r.policeStation,
  policeReportUrl: r.policeReportUrl,
  status: r.status,
  reviewNotes: r.reviewNotes,
  timesChecked: r.hits?.length || 0,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * @swagger
 * /api/imei/check:
 *   post:
 *     summary: Free IMEI check — valid number, which model it belongs to, and whether it's reported stolen
 *     description: >
 *       Open to guests (20 checks per 15 minutes per IP). When the IMEI is
 *       reported stolen the owner is alerted that it was checked. The full
 *       IMEI is never stored for a check.
 *     tags: [IMEI]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [imei]
 *             properties:
 *               imei: { type: string, example: "490154203237518" }
 *               deviceName: { type: string, description: "Optional — what the seller says it is, to compare against the IMEI's model" }
 *     responses:
 *       200:
 *         description: "data: { valid, imeiLast4, device: { brand, model } | null, modelMatch (match | mismatch | unknown, only with deviceName), reportedStolen, stolenReport: { status, policeStation, reportedAt } | null }"
 *       400:
 *         description: Not a valid IMEI
 */
router.post(
  "/check",
  checkLimiter,
  optionalAuth,
  verifyCsrfIfAuthenticated,
  async (req, res, next) => {
    try {
      const parsed = parseImei(req.body?.imei);
      if (parsed.error) return sendError(res, 400, parsed.error);

      const deviceName =
        typeof req.body.deviceName === "string" ? req.body.deviceName.slice(0, 150) : "";
      const model = await compareModel(parsed.tac, deviceName);
      const report = await findOpenStolenReport(hashImei(parsed.imei));
      if (report) await recordStolenHit(report, "check", req.user?._id);

      sendSuccess(res, 200, "IMEI checked", {
        valid: true,
        imeiLast4: parsed.last4,
        device: model.tacModel ? { brand: model.tacBrand, model: model.tacModel } : null,
        modelMatch: deviceName ? model.modelMatch : undefined,
        reportedStolen: !!report,
        stolenReport: report
          ? {
              status: report.status,
              policeStation: report.policeStation,
              reportedAt: report.createdAt.toISOString(),
            }
          : null,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/imei/stolen-reports:
 *   post:
 *     summary: Report your device as stolen
 *     description: >
 *       Starts as pending, which already blocks the IMEI from being listed.
 *       An admin confirms it against the police extract. Upload the extract
 *       first via POST /api/uploads/signature + Cloudinary.
 *     tags: [IMEI]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [imei, brand, model, policeStation, policeReportUrl]
 *             properties:
 *               imei: { type: string }
 *               brand: { type: string, example: Apple }
 *               model: { type: string, example: iPhone 13 Pro }
 *               policeStation: { type: string, example: "Ikeja Police Division, Lagos" }
 *               policeReportUrl: { type: string, description: Cloudinary secure_url of the police extract }
 *               incidentDate: { type: string, format: date }
 *               description: { type: string, maxLength: 1000 }
 *     responses:
 *       201:
 *         description: data.report
 *       400:
 *         description: Missing fields or invalid IMEI
 *       409:
 *         description: This IMEI already has an open report
 *   get:
 *     summary: Your own stolen-device reports
 *     tags: [IMEI]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: data.reports
 */
router.post("/stolen-reports", protect, requireVerified, verifyCsrfToken, async (req, res, next) => {
  try {
    const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const brand = str(req.body.brand, 50);
    const model = str(req.body.model, 100);
    const policeStation = str(req.body.policeStation, 150);
    const { policeReportUrl } = req.body;

    if (!brand || !model || !policeStation)
      return sendError(res, 400, "Fill in the make, model and police station.");
    if (!isOurUpload(policeReportUrl))
      return sendError(res, 400, "Upload a photo or PDF of your police report.");

    const parsed = parseImei(req.body.imei);
    if (parsed.error) return sendError(res, 400, parsed.error);
    const imeiHash = hashImei(parsed.imei);

    if (await findOpenStolenReport(imeiHash))
      return sendError(res, 409, "This IMEI has already been reported stolen.");

    const incidentDate = req.body.incidentDate ? new Date(req.body.incidentDate) : null;

    const report = await StolenReport.create({
      reporter: req.user._id,
      imeiHash,
      imeiLast4: parsed.last4,
      imeiTac: parsed.tac,
      brand,
      model,
      policeStation,
      policeReportUrl,
      incidentDate: incidentDate && !isNaN(incidentDate) ? incidentDate : null,
      description: str(req.body.description, 1000) || null,
    });

    sendSuccess(res, 201, "Report received — we'll review it shortly", {
      report: toClient(report),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/stolen-reports", protect, async (req, res, next) => {
  try {
    const reports = await StolenReport.find({ reporter: req.user._id }).sort({
      createdAt: -1,
    });
    sendSuccess(res, 200, "Reports fetched", { reports: reports.map(toClient) });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/imei/stolen-reports/{id}/recovered:
 *   patch:
 *     summary: Mark your reported device as recovered (stops blocking its IMEI)
 *     tags: [IMEI]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: data.report
 *       404:
 *         description: Report not found
 *       409:
 *         description: Report is already closed
 */
router.patch(
  "/stolen-reports/:id/recovered",
  protect,
  verifyCsrfToken,
  async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id))
        return sendError(res, 404, "Report not found");
      const report = await StolenReport.findOne({
        _id: req.params.id,
        reporter: req.user._id,
      });
      if (!report) return sendError(res, 404, "Report not found");
      if (!["pending", "confirmed"].includes(report.status))
        return sendError(res, 409, "This report is already closed.");

      report.status = "recovered";
      await report.save();
      sendSuccess(res, 200, "Marked as recovered", { report: toClient(report) });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
