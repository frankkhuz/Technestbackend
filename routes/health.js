const express = require("express");
const mongoose = require("mongoose");
const email = require("../utils/email");
const paystack = require("../utils/paystack");
const whatsapp = require("../utils/whatsapp");
const router = express.Router();

const DB_STATES = ["disconnected", "connected", "connecting", "disconnecting"];
const startedAt = new Date();

/**
 * @swagger
 * /api/health:
 *   get:
 *     summary: Is the API up? For uptime monitors and the frontend's status banner
 *     description: >
 *       200 when the API and database are working, 503 when the database is
 *       unreachable. `services` says which optional services are set up
 *       (configured, not necessarily reachable). Point UptimeRobot or
 *       cron-job.org here.
 *     tags: [Health]
 *     security: []
 *     responses:
 *       200:
 *         description: "data: { status: ok, database, uptimeSeconds, version, services: { email, payments, whatsapp, ai } }"
 *       503:
 *         description: "data.status: down — the database is unreachable"
 */
router.get("/", async (req, res) => {
  let database = DB_STATES[mongoose.connection.readyState] || "unknown";
  if (database === "connected") {
    // Connected isn't the same as answering — ping it, briefly
    try {
      await Promise.race([
        mongoose.connection.db.admin().ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
      ]);
    } catch {
      database = "not responding";
    }
  }
  const ok = database === "connected";
  res.status(ok ? 200 : 503).json({
    success: ok,
    message: ok ? "OK" : "The database is unreachable",
    data: {
      status: ok ? "ok" : "down",
      database,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      // Render sets this to the deployed commit
      version: (process.env.RENDER_GIT_COMMIT || "").slice(0, 7) || undefined,
      services: {
        email: email.isConfigured(),
        payments: paystack.isConfigured(),
        whatsapp: whatsapp.isConfigured(),
        ai: !!process.env.ANTHROPIC_API_KEY,
      },
    },
  });
});

module.exports = router;
