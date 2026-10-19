const express = require("express");
const crypto = require("crypto");
const DeviceRequest = require("../models/DeviceRequest");
const Listing = require("../models/Listing");
const { sendSuccess, sendError } = require("../utils/response");
const { settleIfExpired } = require("../utils/matching");
const { runListingExpiry } = require("../utils/listingExpiry");
const router = express.Router();

// Render's free tier has no cron jobs. Point a free scheduler (cron-job.org,
// a scheduled GitHub Action) at POST /api/internal/tick every ~10 minutes
// with the header X-Cron-Secret. Nothing depends on it — expiry is also
// checked whenever a request is read — it just makes closing (and auto-
// picking offers) happen on time when nobody is looking. Calling it also
// keeps the free Render instance awake.
const authorized = (req) => {
  const secret = process.env.INTERNAL_CRON_SECRET;
  const given = String(req.headers["x-cron-secret"] || "");
  return (
    !!secret &&
    given.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))
  );
};

/**
 * @swagger
 * /api/internal/tick:
 *   post:
 *     summary: Scheduler only — close expired requests (auto-picking offers), clear expired holds, remind/expire unconfirmed listings
 *     description: Call every ~10 minutes from cron-job.org with the X-Cron-Secret header. Not for the frontend.
 *     tags: [Internal]
 *     security: []
 *     parameters:
 *       - in: header
 *         name: X-Cron-Secret
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "data: { requestsClosed, holdsCleared, listingsBackfilled, listingsReminded, listingsExpired }"
 *       401:
 *         description: Wrong or missing secret
 *       503:
 *         description: INTERNAL_CRON_SECRET isn't set on the server
 */
router.post("/tick", async (req, res, next) => {
  try {
    if (!process.env.INTERNAL_CRON_SECRET) return sendError(res, 503, "INTERNAL_CRON_SECRET is not set");
    if (!authorized(req)) return sendError(res, 401, "Not authorized");

    const due = await DeviceRequest.find({ status: "open", expiresAt: { $lte: new Date() } }).limit(200);
    let closed = 0;
    for (const r of due) if ((await settleIfExpired(r)).status !== "open") closed++;

    // Holds already count as free once expired; this just tidies the data
    const released = await Listing.updateMany(
      { reservedUntil: { $lte: new Date() } },
      { reservedUntil: null, reservedFor: null }
    );

    const expiry = await runListingExpiry();

    sendSuccess(res, 200, "Tick done", { requestsClosed: closed, holdsCleared: released.modifiedCount, ...expiry });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
