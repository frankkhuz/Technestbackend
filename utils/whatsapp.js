// Phone verification over WhatsApp, two ways:
//   - automatic: the customer sends a code to our verification number; the
//     WhatsApp Cloud API delivers it to POST /api/whatsapp/webhook, and we
//     check the sender is the number they gave. Customer-started chats are
//     free to answer, so this costs nothing per check.
//   - manual: without the Cloud API set up, the customer chats with the
//     sales number and staff mark the number verified in the admin panel.
const crypto = require("crypto");

const isConfigured = () =>
  !!(
    process.env.WHATSAPP_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_APP_SECRET &&
    process.env.WHATSAPP_VERIFY_NUMBER
  );

// Graph API versions retire after about two years — bump this env var
// when Meta announces a deprecation
const apiVersion = () => process.env.WHATSAPP_API_VERSION || "v23.0";

const CODE_TTL_MINUTES = 30;
const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** A code to send from WhatsApp, e.g. "VN-7K3QXP", and its stored hash. */
const newCode = () => {
  const code = "VN-" + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");
  return { code, codeHash: hashCode(code) };
};

const hashCode = (code) => crypto.createHash("sha256").update(String(code).toUpperCase()).digest("hex");

/** Finds a verification code in a message, however it was typed. */
const extractCode = (text) => {
  const m = String(text || "").toUpperCase().match(/\bVN[\s-]?([2-9A-HJ-NP-Z]{6})\b/);
  return m ? `VN-${m[1]}` : null;
};

/** WhatsApp sends senders as "2348031234567"; we store "+2348031234567". */
const fromWaId = (waId) => (/^\d{8,15}$/.test(String(waId)) ? `+${waId}` : null);

/** Meta signs webhook bodies: X-Hub-Signature-256 = "sha256=" + HMAC of the raw body. */
const isValidSignature = (rawBody, header) => {
  if (!rawBody || !header || !process.env.WHATSAPP_APP_SECRET) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** Replies inside the customer's chat (free within 24h of their message). Never throws. */
const sendText = async (to, body) => {
  if (!isConfigured()) return false;
  try {
    const res = await fetch(
      `https://graph.facebook.com/${apiVersion()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body } }),
      }
    );
    if (!res.ok) console.error(`WhatsApp reply failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.error("WhatsApp reply failed:", err.message);
    return false;
  }
};

/** wa.me link with the message pre-typed. */
const chatLink = (number, text) => `https://wa.me/${String(number).replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;

module.exports = {
  CODE_TTL_MINUTES,
  isConfigured,
  newCode,
  hashCode,
  extractCode,
  fromWaId,
  isValidSignature,
  sendText,
  chatLink,
};
