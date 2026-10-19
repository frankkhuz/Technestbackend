const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { protect } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { normalizeNigerianPhone } = require("../utils/pricing");
const { SUPPORT_WHATSAPP } = require("../utils/supportFaq");
const { notifyAdmins } = require("../utils/notify");
const whatsapp = require("../utils/whatsapp");
const router = express.Router();

const startLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: (req, res) => sendError(res, 429, "Too many attempts — please try again in an hour."),
});

const status = (u) => ({
  phone: u.phone,
  phoneVerified: u.phoneVerified,
  verifiedVia: u.phoneVerifiedVia || undefined,
  pending: u.phoneVerification?.phone && !u.phoneVerified
    ? { phone: u.phoneVerification.phone, method: u.phoneVerification.method, expiresAt: u.phoneVerification.expiresAt || undefined }
    : undefined,
  automatic: whatsapp.isConfigured(),
});

/**
 * @swagger
 * /api/phone:
 *   get:
 *     summary: Your phone number and whether it's verified
 *     tags: [Phone]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: "data: { phone, phoneVerified, verifiedVia (whatsapp | admin), pending: { phone, method, expiresAt }, automatic }"
 */
router.get("/", protect, (req, res) => sendSuccess(res, 200, "Phone status", status(req.user)));

/**
 * @swagger
 * /api/phone/verify:
 *   post:
 *     summary: Start verifying a phone number on WhatsApp — open the returned link
 *     description: >
 *       `method: "whatsapp"` (automatic) — the link opens WhatsApp with a
 *       code; sending it from the number given verifies it straight away and
 *       the user gets a confirmation. The code works for 30 minutes.
 *       `method: "manual"` (when automatic isn't set up) — the link opens a
 *       chat with TechNest; staff verify the number from the admin panel.
 *       Poll GET /api/phone, or wait for the notification.
 *     tags: [Phone]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [phone]
 *             properties:
 *               phone: { type: string, example: "0803 123 4567", description: The number that's on WhatsApp }
 *     responses:
 *       200:
 *         description: "data: { method: whatsapp | manual, whatsappUrl, code?, expiresAt? }"
 *       400:
 *         description: Not a Nigerian mobile number
 *       409:
 *         description: Already verified, or verified on another account
 */
router.post("/verify", protect, verifyCsrfToken, startLimiter, async (req, res, next) => {
  try {
    const phone = normalizeNigerianPhone(req.body?.phone || "");
    if (!phone) return sendError(res, 400, "Enter your WhatsApp number, e.g. 0803 123 4567.");
    const user = await User.findById(req.user._id);
    if (user.phoneVerified && user.phone === phone) return sendError(res, 409, "This number is already verified.");
    if (await User.exists({ _id: { $ne: user._id }, phone, phoneVerified: true }))
      return sendError(res, 409, "This number is already verified on another TechNest account. Contact support if it's yours.");

    if (whatsapp.isConfigured()) {
      const { code, codeHash } = whatsapp.newCode();
      const expiresAt = new Date(Date.now() + whatsapp.CODE_TTL_MINUTES * 60 * 1000);
      user.phoneVerification = { phone, method: "whatsapp", codeHash, expiresAt, requestedAt: new Date() };
      await user.save();
      return sendSuccess(res, 200, "Send the message on WhatsApp to verify", {
        method: "whatsapp",
        code,
        expiresAt,
        whatsappUrl: whatsapp.chatLink(process.env.WHATSAPP_VERIFY_NUMBER, `Verify my TechNest number: ${code}`),
      });
    }

    // No Cloud API yet: staff verify it after chatting with the customer
    const firstTime = !(user.phoneVerification?.method === "manual" && user.phoneVerification.phone === phone);
    user.phoneVerification = { phone, method: "manual", requestedAt: new Date() };
    await user.save();
    if (firstTime)
      await notifyAdmins({
        type: "admin_alert",
        title: "Phone number to verify",
        message: `${user.name} (${user.email}) asked to verify ${phone} on WhatsApp.`,
      });
    sendSuccess(res, 200, "Chat with us on WhatsApp and we'll verify your number", {
      method: "manual",
      whatsappUrl: whatsapp.chatLink(
        SUPPORT_WHATSAPP(),
        `Hi TechNest, please verify my number for my account (${user.email}). I'm messaging from ${phone}.`
      ),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
