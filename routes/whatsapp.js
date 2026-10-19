// WhatsApp Cloud API webhook. In the Meta developer dashboard set the
// callback URL to <backend>/api/whatsapp/webhook, the verify token to
// WHATSAPP_VERIFY_TOKEN, and subscribe to "messages".
//
// The POST handler is mounted in server.js with a raw body parser (needed
// to check Meta's signature), outside the JSON/CSRF middleware.
const User = require("../models/User");
const whatsapp = require("../utils/whatsapp");
const { notify } = require("../utils/notify");

// Meta retries deliveries; remember recent message ids so we act once
const seen = new Set();
const firstTimeSeen = (id) => {
  if (!id || seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 2000) seen.delete(seen.values().next().value);
  return true;
};

// GET: Meta's one-time check that the URL is ours
const verifyHandler = (req, res) => {
  const ok =
    req.query["hub.mode"] === "subscribe" &&
    !!process.env.WHATSAPP_VERIFY_TOKEN &&
    req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN;
  if (!ok) return res.sendStatus(403);
  res.status(200).type("text/plain").send(String(req.query["hub.challenge"] || ""));
};

const handleMessage = async (msg) => {
  const sender = whatsapp.fromWaId(msg.from);
  const code = whatsapp.extractCode(msg.text?.body);
  // Ordinary chats aren't ours to answer — staff use the sales number
  if (!sender || !code) return;

  const user = await User.findOne({ "phoneVerification.codeHash": whatsapp.hashCode(code) });
  if (!user || !user.phoneVerification?.expiresAt || user.phoneVerification.expiresAt < new Date())
    return whatsapp.sendText(msg.from, "That code has expired or isn't valid. Open TechNest and tap \"Verify my number\" to get a new one.");
  if (user.phoneVerification.phone !== sender)
    return whatsapp.sendText(
      msg.from,
      `This code was requested for a different number. Send it from ${user.phoneVerification.phone}, or change the number in TechNest.`
    );
  if (await User.exists({ _id: { $ne: user._id }, phone: sender, phoneVerified: true }))
    return whatsapp.sendText(msg.from, "This number is already verified on another TechNest account. Contact support if it's yours.");

  user.phone = sender;
  user.phoneVerified = true;
  user.phoneVerifiedAt = new Date();
  user.phoneVerifiedVia = "whatsapp";
  user.phoneVerification = undefined;
  await user.save();

  await whatsapp.sendText(msg.from, "✅ Your number is verified on TechNest. You can go back to the app.");
  await notify({
    recipient: user._id,
    type: "account_update",
    title: "Phone number verified",
    message: `${sender} is now verified on your TechNest account.`,
    email: false,
  });
};

const webhookHandler = async (req, res) => {
  if (!whatsapp.isValidSignature(req.body, req.headers["x-hub-signature-256"])) return res.sendStatus(401);
  // Acknowledge fast — Meta retries anything slow
  res.sendStatus(200);

  try {
    const payload = JSON.parse(req.body.toString("utf8"));
    for (const entry of payload.entry || [])
      for (const change of entry.changes || [])
        for (const msg of change.value?.messages || [])
          if (msg.type === "text" && firstTimeSeen(msg.id)) await handleMessage(msg);
  } catch (err) {
    console.error("WhatsApp webhook handling failed:", err.message);
  }
};

module.exports = { verifyHandler, webhookHandler };
