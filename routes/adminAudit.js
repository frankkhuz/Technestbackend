const express = require("express");
const mongoose = require("mongoose");
const AuditLog = require("../models/AuditLog");
const { protect, restrictTo } = require("../middleware/auth");
const { sendSuccess } = require("../utils/response");
const router = express.Router();

router.use(protect, restrictTo("admin"));

/**
 * @swagger
 * /api/admin/audit:
 *   get:
 *     summary: What admins changed, newest first
 *     description: >
 *       Every successful admin change is recorded automatically (approvals,
 *       rejections, verifications, prices, orders, payouts, deletions…),
 *       with secrets and uploaded files left out. Kept for two years.
 *     tags: [Admin — Audit]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: actor
 *         description: An admin's user id
 *         schema: { type: string }
 *       - in: query
 *         name: targetId
 *         description: "Everything done to one record (listing, user, order…)"
 *         schema: { type: string }
 *       - in: query
 *         name: q
 *         description: "Text in the action, e.g. approve, finance, products"
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: "data: { entries: [{ actorName, action, path, targetId, details, status, ip, createdAt }], page, pages }"
 */
router.get("/", async (req, res, next) => {
  try {
    const filter = {};
    if (mongoose.isValidObjectId(req.query.actor)) filter.actor = req.query.actor;
    if (typeof req.query.targetId === "string" && /^[a-f0-9]{24}$/i.test(req.query.targetId)) filter.targetId = req.query.targetId;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 50) : "";
    if (q) filter.action = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const [entries, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * 50).limit(50),
      AuditLog.countDocuments(filter),
    ]);
    sendSuccess(res, 200, "Audit log fetched", { entries, page, pages: Math.ceil(total / 50), total });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
