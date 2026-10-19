const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { protect, requireVerified } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { ID_TYPES, compareNames, isOwnPrivateUpload } = require("../utils/identity");
const { notifyAdmins } = require("../utils/notify");
const paystack = require("../utils/paystack");
const router = express.Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  handler: (req, res) => sendError(res, 429, "Too many attempts — please try again in an hour."),
});

const toClient = (identity, identityVerified) => ({
  status: identity?.status || "none",
  identityVerified: !!identityVerified,
  fullName: identity?.fullName,
  idType: identity?.idType,
  bankName: identity?.bankName,
  accountLast4: identity?.accountLast4,
  submittedAt: identity?.submittedAt,
  rejectionReason: identity?.status === "rejected" ? identity.rejectionReason : undefined,
});

/**
 * @swagger
 * /api/identity:
 *   get:
 *     summary: Your identity-check status
 *     tags: [Identity]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: "data: { status: none | pending | verified | rejected, identityVerified, fullName, idType, bankName, accountLast4, submittedAt, rejectionReason }"
 *   post:
 *     summary: Submit ID, selfie and bank account for a free identity check
 *     description: >
 *       Upload the ID photo and a selfie first with POST /api/uploads/signature
 *       `{ purpose: "private" }` and send their `public_id`s. If Paystack is
 *       set up, the bank account name is looked up and compared with the name
 *       on the ID. An admin reviews and approves; the user is notified. Get
 *       the bank list from GET /api/payout-account/banks.
 *     tags: [Identity]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fullName, idType, idDocumentId, selfieId, bankCode, bankName, accountNumber]
 *             properties:
 *               fullName: { type: string, description: Exactly as on the ID }
 *               idType: { type: string, enum: [nin_slip, drivers_licence, international_passport, voters_card] }
 *               idDocumentId: { type: string, description: private upload public_id }
 *               selfieId: { type: string, description: private upload public_id }
 *               bankCode: { type: string }
 *               bankName: { type: string }
 *               accountNumber: { type: string, description: 10 digits }
 *     responses:
 *       200:
 *         description: Submitted — data as for GET
 *       400:
 *         description: Missing/invalid fields, or the bank account couldn't be found
 *       409:
 *         description: Already verified, or a check is already pending
 */
router.get("/", protect, (req, res) => {
  sendSuccess(res, 200, "Identity status", toClient(req.user.identity, req.user.identityVerified));
});

router.post("/", protect, requireVerified, verifyCsrfToken, submitLimiter, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.identityVerified) return sendError(res, 409, "Your identity is already verified.");
    if (user.identity?.status === "pending")
      return sendError(res, 409, "Your details are already being reviewed — we'll notify you.");

    const fullName = String(req.body.fullName || "").trim().replace(/\s+/g, " ").slice(0, 100);
    const { idType, idDocumentId, selfieId } = req.body;
    const bankCode = String(req.body.bankCode || "").trim();
    const bankName = String(req.body.bankName || "").trim().slice(0, 100);
    const accountNumber = String(req.body.accountNumber || "").trim();

    if (fullName.split(" ").length < 2) return sendError(res, 400, "Enter your full name exactly as it is on your ID.");
    if (!ID_TYPES.includes(idType)) return sendError(res, 400, "Choose the type of ID you're uploading.");
    if (!isOwnPrivateUpload(idDocumentId, user._id)) return sendError(res, 400, "Upload a photo of your ID.");
    if (!isOwnPrivateUpload(selfieId, user._id)) return sendError(res, 400, "Upload a selfie.");
    if (!bankCode || !bankName || !/^\d{10}$/.test(accountNumber))
      return sendError(res, 400, "Select your bank and enter your 10-digit account number.");

    let accountName = null;
    if (paystack.isConfigured()) {
      const resolved = await paystack.resolveAccount(accountNumber, bankCode);
      if (resolved.error) return sendError(res, 400, "We couldn't find that bank account — check the number and bank.");
      accountName = resolved.accountName;
    }

    user.identity = {
      status: "pending",
      fullName,
      idType,
      idDocumentId,
      selfieId,
      bankName,
      bankCode,
      accountLast4: accountNumber.slice(-4),
      accountName,
      nameMatch: compareNames(fullName, accountName),
      submittedAt: new Date(),
    };
    await user.save();

    await notifyAdmins({
      type: "admin_alert",
      title: "Identity check to review",
      message: `${fullName} submitted ID for review (bank name check: ${user.identity.nameMatch}).`,
    });

    sendSuccess(res, 200, "Submitted — we'll review it shortly", toClient(user.identity, user.identityVerified));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
