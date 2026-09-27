const express = require("express");
const PayoutAccount = require("../models/PayoutAccount");
const { protect } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const paystack = require("../utils/paystack");
const { PLATFORM_FEE_PERCENT } = require("../utils/pricing");
const router = express.Router();

router.use(protect);

const requirePaystack = (req, res, next) => {
  if (!paystack.isConfigured())
    return sendError(
      res,
      503,
      "Payouts are not configured yet. Add PAYSTACK_SECRET_KEY to the backend .env."
    );
  next();
};

/**
 * @swagger
 * /api/payout-account:
 *   get:
 *     summary: The seller's payout bank account (masked), or null if not set up
 *     tags: [Payouts]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Payout account fetched
 */
router.get("/", async (req, res, next) => {
  try {
    const account = await PayoutAccount.findOne({ user: req.user._id });
    sendSuccess(res, 200, "Payout account fetched", {
      account: account
        ? {
            bankName: account.bankName,
            accountName: account.accountName,
            accountNumberMasked: `••••${account.accountNumber.slice(-4)}`,
          }
        : null,
      platformFeePercent: PLATFORM_FEE_PERCENT,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/payout-account/banks:
 *   get:
 *     summary: Nigerian banks supported for payouts
 *     tags: [Payouts]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Banks fetched
 */
router.get("/banks", requirePaystack, async (req, res, next) => {
  try {
    const result = await paystack.listBanks();
    if (result.error) return sendError(res, 502, result.error);
    sendSuccess(res, 200, "Banks fetched", { banks: result.banks });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/payout-account:
 *   post:
 *     summary: Set or replace the seller's payout bank account
 *     description: Verifies the account number with the bank, then creates a Paystack subaccount for split payments.
 *     tags: [Payouts]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bankCode, bankName, accountNumber]
 *             properties:
 *               bankCode: { type: string }
 *               bankName: { type: string }
 *               accountNumber: { type: string, example: "0123456789" }
 *     responses:
 *       200:
 *         description: Payout account saved
 *       400:
 *         description: Invalid or unverifiable account
 */
router.post("/", verifyCsrfToken, requirePaystack, async (req, res, next) => {
  try {
    const bankCode = String(req.body.bankCode || "").trim();
    const bankName = String(req.body.bankName || "").trim();
    const accountNumber = String(req.body.accountNumber || "").trim();
    if (!bankCode || !bankName || !/^\d{10}$/.test(accountNumber))
      return sendError(
        res,
        400,
        "Select a bank and enter a valid 10-digit account number."
      );

    // Resolving first also confirms the account number is real
    const resolved = await paystack.resolveAccount(accountNumber, bankCode);
    if (resolved.error) return sendError(res, 400, resolved.error);

    const sub = await paystack.createSubaccount({
      businessName: req.user.name || resolved.accountName,
      bankCode,
      accountNumber,
      percentageCharge: PLATFORM_FEE_PERCENT,
    });
    if (sub.error) return sendError(res, 502, sub.error);

    await PayoutAccount.findOneAndUpdate(
      { user: req.user._id },
      {
        user: req.user._id,
        bankCode,
        bankName,
        accountNumber,
        accountName: resolved.accountName,
        subaccountCode: sub.subaccountCode,
      },
      { upsert: true, returnDocument: "after", runValidators: true }
    );

    sendSuccess(res, 200, "Payout account saved", {
      accountName: resolved.accountName,
      bankName,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
