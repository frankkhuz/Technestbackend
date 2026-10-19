const express = require("express");
const { protect } = require("../middleware/auth");
const { sendSuccess } = require("../utils/response");
const router = express.Router();

/**
 * @swagger
 * /api/me:
 *   get:
 *     summary: Get the current logged-in user's info
 *     tags: [Me]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: User info fetched
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Not authorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/", protect, (req, res) => {
  sendSuccess(res, 200, "User fetched", {
    id: req.user._id,
    name: req.user.name,
    email: req.user.email,
    userType: req.user.userType,
    isVerified: req.user.isVerified,
    createdAt: req.user.createdAt,
    vendorVerified: req.user.vendorVerified,
    vendorProfile: req.user.vendorProfile,
    identityVerified: req.user.identityVerified,
    identityStatus: req.user.identity?.status || "none",
    phone: req.user.phone,
    phoneVerified: req.user.phoneVerified,
  });
});

module.exports = router;
