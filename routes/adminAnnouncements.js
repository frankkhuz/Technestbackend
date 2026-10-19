const express = require("express");
const Announcement = require("../models/Announcement");
const Notification = require("../models/Notification");
const User = require("../models/User");
const { protect, restrictTo } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { sendEmail, clientUrl, isConfigured, unsubscribeUrl } = require("../utils/email");
const router = express.Router();

router.use(protect, restrictTo("admin"));

const AUDIENCES = {
  all_vendors: { userType: "vendor" },
  approved_vendors: { userType: "vendor", vendorVerified: true },
  pending_vendors: { userType: "vendor", vendorVerified: false },
  customers: { userType: "user" },
  everyone: { userType: { $in: ["user", "vendor"] } },
};

// Brevo's free plan allows 300 emails a day; leave room for signups and
// notifications. Raise ANNOUNCEMENT_EMAIL_LIMIT on a paid plan.
const emailLimit = () => Number(process.env.ANNOUNCEMENT_EMAIL_LIMIT) || 200;

// Sends a few at a time in the background and records progress
const sendInBackground = async (announcement, users) => {
  const queue = [...users];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      const ok = await sendEmail({
        to: u.email,
        toName: u.name,
        subject: announcement.title,
        paragraphs: [`Hi ${u.name.split(" ")[0]},`, ...announcement.message.split(/\n{2,}/)],
        button: { label: "Open TechNest", url: clientUrl() },
        footnote: "You're getting this because you have a TechNest account.",
        unsubscribeUrl: unsubscribeUrl(u._id, "announcements"),
      });
      await Announcement.updateOne({ _id: announcement._id }, { $inc: ok ? { emailsSent: 1 } : { emailsFailed: 1 } });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
};

/**
 * @swagger
 * /api/admin/announcements:
 *   post:
 *     summary: Send a message to a group of users (in-app, plus email if chosen)
 *     description: >
 *       Use `dryRun: true` to see how many people it would reach. Emails go
 *       out in the background, capped at ANNOUNCEMENT_EMAIL_LIMIT (default
 *       200) to stay inside the free email quota — check progress with GET.
 *       Separate paragraphs in `message` with a blank line.
 *     tags: [Admin — Announcements]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [audience, title, message]
 *             properties:
 *               audience: { type: string, enum: [all_vendors, approved_vendors, pending_vendors, customers, everyone] }
 *               title: { type: string, maxLength: 150 }
 *               message: { type: string, maxLength: 2000 }
 *               sendEmail: { type: boolean }
 *               dryRun: { type: boolean }
 *     responses:
 *       201:
 *         description: "data: { announcement, recipients, emailsQueued, emailsSkipped }"
 *       200:
 *         description: "dryRun: data.recipients"
 *   get:
 *     summary: Past announcements with email progress
 *     tags: [Admin — Announcements]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: data.announcements
 */
router.post("/", verifyCsrfToken, async (req, res, next) => {
  try {
    const { audience } = req.body;
    const title = String(req.body.title || "").trim().slice(0, 150);
    const message = String(req.body.message || "").trim().slice(0, 2000);
    if (!AUDIENCES[audience]) return sendError(res, 400, `audience must be one of: ${Object.keys(AUDIENCES).join(", ")}`);
    if (!title || !message) return sendError(res, 400, "Write a title and a message.");

    const users = await User.find({ ...AUDIENCES[audience], deletedAt: null }).select("name email emailPrefs");
    if (req.body.dryRun === true) return sendSuccess(res, 200, "Preview — nothing sent", { recipients: users.length });
    if (!users.length) return sendError(res, 400, "Nobody is in that audience yet.");

    const sendEmails = req.body.sendEmail === true;
    // People who unsubscribed still get it in-app
    const emailed = sendEmails ? users.filter((u) => u.emailPrefs?.announcements !== false).slice(0, emailLimit()) : [];
    const announcement = await Announcement.create({
      audience,
      title,
      message,
      sendEmail: sendEmails,
      recipients: users.length,
      emailsQueued: emailed.length,
      createdBy: req.user._id,
    });

    // The in-app message is capped at the notification's 500 characters
    await Notification.insertMany(
      users.map((u) => ({
        recipientType: "specific",
        recipient: u._id,
        type: "announcement",
        title,
        message: message.length > 500 ? `${message.slice(0, 497)}...` : message,
      }))
    );
    if (emailed.length)
      sendInBackground(announcement, emailed).catch((err) => console.error("Announcement emails failed:", err.message));

    sendSuccess(res, 201, "Announcement sent", {
      announcement,
      recipients: users.length,
      emailsQueued: emailed.length,
      // Over the daily cap, or unsubscribed from announcements
      emailsSkipped: sendEmails ? users.length - emailed.length : 0,
      emailConfigured: isConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const announcements = await Announcement.find().populate("createdBy", "name").sort({ createdAt: -1 }).limit(50);
    sendSuccess(res, 200, "Announcements fetched", { announcements });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
