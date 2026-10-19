const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { normalizeNigerianPhone } = require("../utils/pricing");
const { notify } = require("../utils/notify");
const router = express.Router();

router.use(protect, restrictTo("admin"));

const SUMMARY = "name email userType isVerified phone phoneVerified phoneVerifiedVia phoneVerifiedAt phoneVerification.phone phoneVerification.method phoneVerification.requestedAt identityVerified vendorVerified createdAt";

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Find users — e.g. the customer you're chatting with on WhatsApp
 *     tags: [Admin — Users]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string, description: "Name, email or phone (any format)" }
 *       - in: query
 *         name: phonePending
 *         description: "true = users waiting for staff to verify their number"
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: "data.users: [{ _id, name, email, userType, phone, phoneVerified, phoneVerifiedVia, phoneVerification: { phone, method, requestedAt }, ... }]"
 */
router.get("/", async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.phonePending === "true") Object.assign(filter, { phoneVerified: false, "phoneVerification.method": "manual" });
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 60) : "";
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const phone = normalizeNigerianPhone(q);
      filter.$or = [{ name: rx }, { email: rx }, ...(phone ? [{ phone }, { "phoneVerification.phone": phone }] : [])];
    }
    const users = await User.find(filter).select(SUMMARY).sort({ "phoneVerification.requestedAt": -1, createdAt: -1 }).limit(100);
    sendSuccess(res, 200, "Users fetched", { users });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/users/{id}/phone:
 *   patch:
 *     summary: Mark a user's phone verified (or not) after checking it on WhatsApp
 *     description: >
 *       Leave out `phone` to verify the number they asked about. Only verify
 *       a number you've seen message you from WhatsApp. The user is notified.
 *     tags: [Admin — Users]
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
 *             required: [verified]
 *             properties:
 *               verified: { type: boolean }
 *               phone: { type: string }
 *     responses:
 *       200:
 *         description: data.user
 *       400:
 *         description: No valid number
 *       409:
 *         description: Number verified on another account
 */
router.patch("/:id/phone", verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "User not found");
    const user = await User.findById(req.params.id);
    if (!user) return sendError(res, 404, "User not found");
    if (typeof req.body.verified !== "boolean") return sendError(res, 400, "verified must be true or false");

    if (!req.body.verified) {
      user.phoneVerified = false;
      user.phoneVerifiedVia = null;
      user.phoneVerifiedAt = null;
      await user.save();
      return sendSuccess(res, 200, "Phone marked unverified", { user: await User.findById(user._id).select(SUMMARY) });
    }

    const phone = normalizeNigerianPhone(req.body.phone || user.phoneVerification?.phone || user.phone || "");
    if (!phone) return sendError(res, 400, "Enter the Nigerian number you verified.");
    if (await User.exists({ _id: { $ne: user._id }, phone, phoneVerified: true }))
      return sendError(res, 409, "That number is already verified on another account.");

    user.phone = phone;
    user.phoneVerified = true;
    user.phoneVerifiedVia = "admin";
    user.phoneVerifiedAt = new Date();
    user.phoneVerification = undefined;
    await user.save();
    await notify({
      recipient: user._id,
      type: "account_update",
      title: "Phone number verified",
      message: `${phone} is now verified on your TechNest account.`,
    });
    sendSuccess(res, 200, "Phone verified", { user: await User.findById(user._id).select(SUMMARY) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
