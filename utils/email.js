// Transactional email over a provider's HTTP API — no SMTP, no extra
// dependency. Both providers have free tiers:
//   - Brevo:  300 emails/day; can send from a single verified address (even
//             a Gmail) without owning a domain
//   - Resend: 3,000 emails/month; needs a verified domain to email anyone
//             other than yourself
// With no provider configured, emails are logged instead of sent so the
// rest of the app keeps working in development.
const PROVIDERS = {
  brevo: (msg) =>
    fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "api-key": process.env.EMAIL_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { name: fromName(), email: process.env.EMAIL_FROM },
        to: [{ email: msg.to, ...(msg.toName ? { name: msg.toName } : {}) }],
        subject: msg.subject,
        htmlContent: msg.html,
        textContent: msg.text,
        ...(msg.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${msg.unsubscribeUrl}>` } } : {}),
      }),
    }),
  resend: (msg) =>
    fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${fromName()} <${process.env.EMAIL_FROM}>`,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.unsubscribeUrl ? { headers: { "List-Unsubscribe": `<${msg.unsubscribeUrl}>` } } : {}),
      }),
    }),
};

const fromName = () => process.env.EMAIL_FROM_NAME || "TechNest";
const provider = () => PROVIDERS[String(process.env.EMAIL_PROVIDER || "").toLowerCase()];

const isConfigured = () =>
  !!(provider() && process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);

const clientUrl = () =>
  (process.env.CLIENT_URL || "https://technest11.vercel.app").replace(/\/$/, "");

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// One plain, mobile-friendly layout for every email. Inline styles only —
// most email clients ignore <style> blocks.
const layout = ({ heading, paragraphs, button, footnote, unsubscribeUrl }) => {
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="font-size:20px;font-weight:bold;color:#111827;padding-bottom:4px">TechNest</td></tr>
<tr><td style="font-size:18px;font-weight:bold;padding:16px 0 8px">${escapeHtml(heading)}</td></tr>
${paragraphs.map((p) => `<tr><td style="font-size:15px;line-height:1.55;padding:4px 0">${escapeHtml(p)}</td></tr>`).join("")}
${button ? `<tr><td style="padding:20px 0 8px"><a href="${escapeHtml(button.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:8px">${escapeHtml(button.label)}</a></td></tr>` : ""}
${footnote ? `<tr><td style="font-size:12px;line-height:1.5;color:#6b7280;padding-top:16px">${escapeHtml(footnote)}</td></tr>` : ""}
${unsubscribeUrl ? `<tr><td style="font-size:12px;color:#6b7280;padding-top:8px"><a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">Unsubscribe from these emails</a></td></tr>` : ""}
</table></td></tr></table></body></html>`;
  const text = [heading, "", ...paragraphs, ...(button ? ["", `${button.label}: ${button.url}`] : []), ...(footnote ? ["", footnote] : []), ...(unsubscribeUrl ? ["", `Unsubscribe: ${unsubscribeUrl}`] : [])].join("\n");
  return { html, text };
};

/**
 * Sends one email. Never throws — a failed email must not fail the request
 * that triggered it. Resolves to true when the provider accepted it.
 */
const sendEmail = async ({ to, toName, subject, heading, paragraphs, button, footnote, unsubscribeUrl }) => {
  const { html, text } = layout({ heading: heading || subject, paragraphs, button, footnote, unsubscribeUrl });
  if (!isConfigured()) {
    console.log(`[email not configured] to=${to} subject="${subject}"${button ? ` link=${button.url}` : ""}`);
    return false;
  }
  try {
    const res = await provider()({ to, toName, subject, html, text, unsubscribeUrl });
    if (!res.ok) {
      console.error(`Email to ${to} failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Email to ${to} failed: ${err.message}`);
    return false;
  }
};

// One-click unsubscribe without logging in: the link carries an HMAC of
// the user id and email type, so it can't be forged for someone else.
// It goes through the frontend's /api rewrite to GET /api/me/unsubscribe.
const UNSUBSCRIBE_TYPES = ["notifications", "announcements"];
const unsubscribeSignature = (userId, type) =>
  require("crypto").createHmac("sha256", process.env.JWT_SECRET).update(`unsubscribe:${userId}:${type}`).digest("hex").slice(0, 32);
const unsubscribeUrl = (userId, type) =>
  `${clientUrl()}/api/me/unsubscribe?u=${userId}&t=${type}&s=${unsubscribeSignature(String(userId), type)}`;

const sendVerificationEmail = (user, rawToken) =>
  sendEmail({
    to: user.email,
    toName: user.name,
    subject: "Confirm your email for TechNest",
    heading: `Welcome to TechNest, ${user.name.split(" ")[0]}`,
    paragraphs: ["Please confirm this is your email address so you can list, buy and swap devices."],
    // Goes through the frontend's /api rewrite to the backend, which marks
    // the account verified and redirects to the login page (/auth/login)
    button: { label: "Confirm my email", url: `${clientUrl()}/api/auth/verify-email/${rawToken}` },
    footnote: "This link expires in 24 hours. If you didn't create a TechNest account, ignore this email.",
  });

const sendPasswordResetEmail = (user, rawToken) =>
  sendEmail({
    to: user.email,
    toName: user.name,
    subject: "Reset your TechNest password",
    heading: "Reset your password",
    paragraphs: ["Someone (hopefully you) asked to reset the password for this TechNest account."],
    button: { label: "Choose a new password", url: `${clientUrl()}/auth/reset-password?token=${rawToken}` },
    footnote: "This link expires in 1 hour. If you didn't ask for this, ignore this email — your password won't change.",
  });

module.exports = {
  UNSUBSCRIBE_TYPES,
  unsubscribeSignature,
  unsubscribeUrl,
  isConfigured,
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  clientUrl,
};
