const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { privateUrl } = require("../utils/identity");
const { notify } = require("../utils/notify");
const router = express.Router();

router.use(protect, restrictTo("admin"));

/**
 * @swagger
 * /api/admin/identity:
 *   get:
 *     summary: Identity checks to review, with signed links to the ID photo and selfie
 *     tags: [Admin — Identity]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, verified, rejected], default: pending }
 *     responses:
 *       200:
 *         description: "data.people: [{ userId, name, email, userType, identity: { fullName, idType, bankName, accountLast4, accountName, nameMatch, submittedAt, idDocumentUrl, selfieUrl } }]"
 */
router.get("/", async (req, res, next) => {
  try {
    const status = ["pending", "verified", "rejected"].includes(req.query.status) ? req.query.status : "pending";
    const users = await User.find({ "identity.status": status })
      .select("name email userType identity createdAt")
      .sort({ "identity.submittedAt": 1 })
      .limit(200);
    sendSuccess(res, 200, "Identity checks fetched", {
      people: users.map((u) => {
        const { idDocumentId, selfieId, bankCode, ...rest } = u.identity.toObject();
        return {
          userId: u._id,
          name: u.name,
          email: u.email,
          userType: u.userType,
          memberSince: u.createdAt,
          identity: { ...rest, idDocumentUrl: privateUrl(idDocumentId), selfieUrl: privateUrl(selfieId) },
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/admin/identity/{userId}:
 *   patch:
 *     summary: Approve or reject an identity check
 *     description: Approving gives the user the "verified seller" badge. The user is notified either way.
 *     tags: [Admin — Identity]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
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
 *               status: { type: string, enum: [verified, rejected] }
 *               reason: { type: string, description: "Shown to the user when rejected" }
 *     responses:
 *       200:
 *         description: Updated
 *       409:
 *         description: Nothing pending for this user
 */
router.patch("/:userId", verifyCsrfToken, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["verified", "rejected"].includes(status)) return sendError(res, 400, "status must be verified or rejected");
    if (!mongoose.isValidObjectId(req.params.userId)) return sendError(res, 404, "User not found");
    const user = await User.findById(req.params.userId);
    if (!user) return sendError(res, 404, "User not found");
    if (user.identity?.status !== "pending") return sendError(res, 409, "There's no identity check pending for this user.");

    const reason = typeof req.body.reason === "string" ? req.body.reason.trim().slice(0, 300) : "";
    user.identity.status = status;
    user.identity.reviewedAt = new Date();
    user.identity.reviewedBy = req.user._id;
    user.identity.rejectionReason = status === "rejected" ? reason || null : null;
    user.identityVerified = status === "verified";
    await user.save();

    await notify({
      recipient: user._id,
      type: "identity_update",
      title: status === "verified" ? "You're a verified seller" : "We couldn't verify your identity",
      message:
        status === "verified"
          ? "Your identity check passed. Your listings now show a verified badge."
          : `We couldn't verify your identity${reason ? `: ${reason}` : "."} You can submit your details again.`,
    });

    sendSuccess(res, 200, "Identity check updated", {
      userId: user._id,
      status: user.identity.status,
      identityVerified: user.identityVerified,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
