// The one way to tell users something: saves the in-app notification and
// emails it too. Use this instead of Notification.create so every event
// reaches people who aren't looking at the app.
const Notification = require("../models/Notification");
const User = require("../models/User");
const { sendEmail, clientUrl } = require("./email");

/**
 * Notifies specific users. Each gets their own notification (so read
 * state is per person) and, unless email is false, an email.
 * Email failures are logged, never thrown.
 *
 * @param {object|object[]} items  { recipient, type, title, message,
 *                                   listing?, transaction?, order?, email? }
 */
const notify = async (items) => {
  const list = (Array.isArray(items) ? items : [items]).filter((n) => n?.recipient);
  if (!list.length) return;

  await Notification.insertMany(
    list.map(({ email, ...n }) => ({ ...n, recipientType: "specific" }))
  );

  const emailed = list.filter((n) => n.email !== false);
  if (!emailed.length) return;
  const users = await User.find({ _id: { $in: emailed.map((n) => n.recipient) } }).select("name email");
  const byId = new Map(users.map((u) => [String(u._id), u]));

  // Not awaited: a slow email provider shouldn't hold up the response
  Promise.all(
    emailed.map((n) => {
      const user = byId.get(String(n.recipient));
      if (!user?.email) return null;
      return sendEmail({
        to: user.email,
        toName: user.name,
        subject: n.title,
        paragraphs: [`Hi ${user.name.split(" ")[0]},`, n.message],
        button: { label: "Open TechNest", url: clientUrl() },
        footnote: "You're getting this because of activity on your TechNest account.",
      });
    })
  ).catch((err) => console.error("Notification emails failed:", err.message));
};

/**
 * In-app only, one copy per approved vendor — replaces the old shared
 * "all_vendors" broadcast, whose single read flag was shared by everyone.
 * No email: this fires on every approved listing and would burn through a
 * free email quota.
 */
const notifyVendors = async (fields) => {
  const vendors = await User.find({ userType: "vendor", vendorVerified: true }).select("_id");
  await notify(vendors.map((v) => ({ ...fields, recipient: v._id, email: false })));
};

/** Tells every admin (in-app + email) — for things staff must act on. */
const notifyAdmins = async (fields) => {
  const admins = await User.find({ userType: "admin" }).select("_id");
  await notify(admins.map((a) => ({ ...fields, recipient: a._id })));
};

module.exports = { notify, notifyVendors, notifyAdmins };
