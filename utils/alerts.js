// Emails the team when something breaks on the server — unexpected errors,
// the database going away, crashes in background work — so problems don't
// sit unnoticed in Render's logs. Set ERROR_ALERT_EMAIL (comma-separated
// for several people). Uses the normal email provider; no extra service.
//
// Throttled so an outage can't flood the inbox: the same problem alerts at
// most once an hour, and at most 20 alerts go out per day.
const { sendEmail, isConfigured } = require("./email");

const PER_KEY_MS = 60 * 60 * 1000;
const DAILY_MAX = 20;
const lastSent = new Map();
let day = "";
let sentToday = 0;

const recipients = () =>
  String(process.env.ERROR_ALERT_EMAIL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * @param {string} title   what happened, e.g. "Server error"
 * @param {string} where   e.g. "PATCH /api/admin/order-requests/:id"
 * @param {string} detail  error message / stack (trimmed)
 */
const alertTeam = (title, where, detail = "") => {
  const to = recipients();
  if (!to.length || !isConfigured()) return;
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) [day, sentToday] = [today, 0];
  const key = `${title}|${where}|${String(detail).split("\n")[0].slice(0, 120)}`;
  if (Date.now() - (lastSent.get(key) || 0) < PER_KEY_MS || sentToday >= DAILY_MAX) return;
  lastSent.set(key, Date.now());
  sentToday++;
  if (lastSent.size > 500) lastSent.delete(lastSent.keys().next().value);

  const version = (process.env.RENDER_GIT_COMMIT || "").slice(0, 7);
  for (const address of to)
    sendEmail({
      to: address,
      subject: `⚠️ TechNest backend: ${title}`,
      heading: title,
      paragraphs: [
        `Where: ${where}`,
        `When: ${new Date().toISOString()}${version ? ` (version ${version})` : ""}`,
        String(detail).slice(0, 1500),
      ],
      footnote: "The same problem alerts at most once an hour. Full details are in the Render logs.",
    });
};

module.exports = { alertTeam };
