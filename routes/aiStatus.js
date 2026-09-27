const express = require("express");
const { sendSuccess } = require("../utils/response");
const ai = require("../utils/ai");
const router = express.Router();

/**
 * @swagger
 * /api/ai/status:
 *   get:
 *     summary: Is AI available right now?
 *     description: >
 *       Use it to decide whether to show AI-only extras (e.g. the "Fill in
 *       from photos" button, an "AI" badge). Everything still works when
 *       `enabled` is false — the app uses its free built-in answers.
 *       `reason`: not_configured | disabled | paused | daily_limit.
 *     tags: [AI]
 *     security: []
 *     responses:
 *       200:
 *         description: data.enabled, data.reason
 */
router.get("/status", async (req, res, next) => {
  try {
    const { enabled, reason } = await ai.getStatus();
    sendSuccess(res, 200, "AI status", { enabled, reason });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
