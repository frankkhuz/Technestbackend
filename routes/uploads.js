const express = require("express");
const cloudinary = require("../config/cloudinary");
const { protect } = require("../middleware/auth");
const { sendSuccess } = require("../utils/response");
const router = express.Router();

/**
 * @swagger
 * /api/uploads/signature:
 *   post:
 *     summary: Get a signed Cloudinary upload signature for direct browser upload
 *     description: >
 *       Default: public listing photos (folder technest/listings) — send the
 *       returned `secure_url`. With `{ "purpose": "private" }` (ID documents,
 *       selfies, CAC certificates) the upload is `type: authenticated` in your
 *       own private folder: include `type=authenticated` in the upload form,
 *       and send us the returned **`public_id`**, not the URL — the file can
 *       only be opened through short signed links we give admins.
 *     tags: [Uploads]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               purpose: { type: string, enum: [listing, private] }
 *     responses:
 *       200:
 *         description: "data: { signature, timestamp, folder, type?, cloudName, apiKey }"
 */
router.post("/signature", protect, (req, res) => {
  const timestamp = Math.round(Date.now() / 1000);
  const isPrivate = req.body?.purpose === "private";
  const folder = isPrivate ? `technest/private/${req.user._id}` : "technest/listings";

  // Only these params are signed — anything else the browser sends to
  // Cloudinary that isn't part of this signed set gets rejected by
  // Cloudinary itself, so this can't be tampered with to upload
  // somewhere else, bypass the folder scoping, or make a private file public.
  const paramsToSign = isPrivate ? { timestamp, folder, type: "authenticated" } : { timestamp, folder };
  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET
  );

  sendSuccess(res, 200, "Signature generated", {
    signature,
    timestamp,
    folder,
    ...(isPrivate ? { type: "authenticated" } : {}),
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
  });
});

module.exports = router;
