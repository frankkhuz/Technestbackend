const express = require("express");
const Product = require("../models/Product");
const { optionalAuth } = require("../middleware/auth");
const { verifyCsrfIfAuthenticated } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const aiSoftLimit = require("../utils/aiSoftLimit");
const ai = require("../utils/ai");
const { SUPPORT_WHATSAPP } = require("../utils/supportFaq");
const repairServices = require("../data/repairs.json");
const router = express.Router();

// Estimated Nigerian repair price ranges (data/repairs.json) — every reply
// says they're estimates and points to WhatsApp for an exact quote.
const serviceById = new Map(repairServices.map((r) => [r.id, r]));

const loadAccessories = async () =>
  Product.find({
    isActive: true,
    inStock: true,
    type: "gadget",
    category: { $in: ["accessory", "power"] },
  }).sort({ priceUkUsed: 1 });

// ── Free triage rules ───────────────────────────────────────────────────────
const DEVICE_WORDS = {
  phone: /\b(phone|iphone|samsung|galaxy|pixel|tecno|infinix|android|redmi|xiaomi)\b/i,
  laptop: /\b(laptop|macbook|notebook|hp|dell|lenovo|asus|acer|computer|pc)\b/i,
  tablet: /\b(tablet|ipad)\b/i,
  console: /\b(console|ps4|ps5|playstation|xbox|nintendo|switch)\b/i,
};

const FORCE_RESTART = {
  phone: "Force-restart it: on iPhone press volume up, volume down, then hold the side button until the Apple logo; on Android hold power + volume down for 10–15 seconds.",
  laptop: "Unplug it and hold the power button for 15–20 seconds, then plug the charger back in and switch on.",
  tablet: "Force-restart it by holding the power (and volume down) buttons for 10–15 seconds.",
  console: "Turn it off at the wall for 2 minutes, then switch back on.",
};

// Order matters: the first matching issue wins
const ISSUES = [
  {
    id: "water",
    match: /\b(water|wet|liquid|rain|spill\w*|drop(ped)? (it )?in|pool|toilet|sea)\b/i,
    label: "liquid damage",
    repairs: { any: ["water-damage-service"] },
    steps: [
      "Switch it off now and don't try to charge it.",
      "Remove the case and SIM tray, wipe it dry and leave it upright somewhere airy — skip the rice, it doesn't help.",
      "Get it to a technician within a day or two; corrosion gets worse with time.",
    ],
    urgent: true,
  },
  {
    id: "no_power",
    match: /\b(won'?t|doesn'?t|does not|will not|can'?t|not) (turn|switch|power|come|boot)\w*( on| up)?\b|\b(dead|no power|black screen|won'?t start)\b/i,
    label: "not turning on",
    repairs: { any: ["general-diagnostic"] },
    steps: ["Charge it with a known-good charger for at least 30 minutes.", "FORCE_RESTART"],
    urgent: true,
  },
  {
    id: "charging",
    match: /\b(charg\w*|port|cable|plug|lightning|usb)\b/i,
    label: "charging problem",
    repairs: { phone: ["charging-port-repair"], laptop: ["charging-port-repair"], tablet: ["charging-port-repair"], any: ["charging-port-repair"] },
    steps: [
      "Try a different cable and charger you know work.",
      "Look inside the port with a torch; gently clear lint with a wooden toothpick (never metal).",
      "FORCE_RESTART",
    ],
    products: /charger|cable|adapter|cleaning kit/i,
  },
  {
    id: "battery",
    match: /\b(battery|drain\w*|dies (fast|quickly)|percentage|swell\w*|bloat\w*|shuts? (down|off))\b/i,
    label: "battery problem",
    repairs: { phone: ["battery-replacement-phone"], laptop: ["battery-replacement-laptop"], any: ["battery-replacement-phone"] },
    steps: [
      "Check battery health (iPhone: Settings → Battery → Battery Health). Under 80% usually means it needs replacing.",
      "Lower screen brightness and check which apps use the most battery.",
      "If the battery or case is swelling, stop charging it and see a technician straight away.",
    ],
    products: /power bank|powerbank/i,
  },
  {
    id: "screen",
    match: /\b(screen|display|crack\w*|shatter\w*|lines|touch|flicker\w*|dead pixel\w*|lcd|oled)\b/i,
    label: "screen problem",
    repairs: { phone: ["screen-replacement-budget", "screen-replacement-oem"], laptop: ["screen-replacement-laptop"], tablet: ["screen-replacement-budget"], any: ["screen-replacement-budget", "screen-replacement-oem"] },
    steps: ["If touch is unresponsive but the screen isn't cracked, FORCE_RESTART_LOWER", "Remove any thick or cracked screen protector and test again."],
  },
  {
    id: "back_glass",
    match: /\b(back (glass|cover|panel)|back is crack\w*|rear glass)\b/i,
    label: "cracked back glass",
    repairs: { any: ["back-glass-replacement"] },
    steps: ["Cover sharp edges with clear tape until it's fixed."],
  },
  {
    id: "camera",
    match: /\b(camera|blurry|lens|focus|photos?)\b/i,
    label: "camera problem",
    repairs: { any: ["camera-repair"] },
    steps: ["Clean the lens with a soft cloth.", "Close and reopen the camera app, then FORCE_RESTART_LOWER"],
  },
  {
    id: "audio",
    match: /\b(speaker|mic|microphone|can'?t hear|sound|audio|volume low|muffled)\b/i,
    label: "sound or microphone problem",
    repairs: { any: ["speaker-mic-repair"] },
    steps: ["Gently brush the speaker and mic holes with a soft, dry toothbrush.", "Check it isn't connected to Bluetooth headphones.", "FORCE_RESTART"],
  },
  {
    id: "buttons",
    match: /\b(button|buttons|power key|volume key|side key)\b/i,
    label: "button problem",
    repairs: { any: ["button-repair"] },
    steps: ["Remove the case — tight cases often jam buttons."],
  },
  {
    id: "hdmi",
    match: /\b(hdmi|no signal|tv)\b/i,
    label: "no picture on TV",
    repairs: { any: ["hdmi-port-repair"] },
    steps: ["Try another HDMI cable and TV input.", "FORCE_RESTART"],
  },
  {
    id: "overheating",
    match: /\b(hot|heat\w*|overheat\w*|fan|loud|noisy)\b/i,
    label: "overheating",
    repairs: { laptop: ["fan-cleaning-repair"], console: ["fan-cleaning-repair"], any: ["general-diagnostic"] },
    steps: ["Use it on a hard, flat surface with the vents clear.", "Close heavy apps or games and let it cool before charging."],
  },
  {
    id: "keyboard",
    match: /\b(keyboard|keys?|trackpad|touchpad)\b/i,
    label: "keyboard problem",
    repairs: { laptop: ["keyboard-repair-laptop"], any: ["keyboard-repair-laptop"] },
    steps: ["Turn it upside down and gently tap out crumbs; use compressed air if you have it."],
  },
];

const rulesTriage = async (messages) => {
  const userText = messages.filter((m) => m.role === "user").map((m) => m.content).join(" \n ");
  const device = Object.keys(DEVICE_WORDS).find((k) => DEVICE_WORDS[k].test(userText)) || null;
  const issue = ISSUES.find((i) => i.match.test(userText));
  const alreadyAsked = messages.some((m) => m.role === "assistant");

  if (!issue) {
    return {
      type: "question",
      message: alreadyAsked
        ? "I couldn't tell what the problem is. Pick the closest: cracked screen, won't charge, battery drains fast, got wet, won't turn on, no sound, camera problem, overheating — or book a technician on WhatsApp for a full check."
        : "Sorry about that! What's happening with it — for example cracked screen, won't charge, battery drains fast, got wet, or won't turn on? And is it a phone, laptop, tablet or console?",
      quickFixSteps: [],
      repairMatches: [],
      productMatches: [],
      suggestRepairerContact: alreadyAsked,
    };
  }

  const kind = device || "phone";
  const restart = FORCE_RESTART[kind];
  const steps = issue.steps.map((s) =>
    s === "FORCE_RESTART"
      ? restart
      : s.replace("FORCE_RESTART_LOWER", restart.charAt(0).toLowerCase() + restart.slice(1))
  );
  const repairIds = issue.repairs[kind] || issue.repairs.any || [];
  const repairMatches = repairIds
    .filter((id) => serviceById.has(id))
    .map((id) => ({ id, reason: `Typical fix for ${issue.label}${device ? ` on a ${device}` : ""}.` }));

  let productMatches = [];
  if (issue.products) {
    const accessories = await loadAccessories();
    // Prefer accessories for this kind of device (Lightning for iPhone, USB-C
    // for Android, laptop chargers for laptops), cheapest first
    const prefer = /\b(iphone|ipad)\b/i.test(userText)
      ? /iphone|lightning/i
      : kind === "laptop"
      ? /laptop/i
      : /android|type-c|usb-c/i;
    const text = (p) => `${p.name} ${p.spec || ""} ${p.tags.join(" ")}`;
    productMatches = accessories
      .filter((p) => issue.products.test(text(p)))
      .sort((a, b) => Number(prefer.test(text(b))) - Number(prefer.test(text(a))) || a.priceUkUsed - b.priceUkUsed)
      .slice(0, 2)
      .map((p) => ({ id: p.slug, reason: "Rules out a faulty charger or cable, or keeps you going meanwhile." }));
  }

  return {
    type: "diagnosis",
    message: `Sounds like a ${issue.label}${device ? ` on your ${device}` : ""}. ${
      issue.urgent ? "Act quickly — " : ""
    }try the quick checks below first; if they don't help, here's what a repair usually costs (estimates — a technician confirms the exact price).`,
    quickFixSteps: steps,
    repairMatches,
    productMatches,
    suggestRepairerContact: true,
  };
};

// ── AI triage ───────────────────────────────────────────────────────────────
const TRIAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["question", "diagnosis"] },
    message: { type: "string" },
    quickFixSteps: { type: "array", items: { type: "string" } },
    repairMatches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, reason: { type: "string" } },
        required: ["id", "reason"],
      },
    },
    productMatches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, reason: { type: "string" } },
        required: ["id", "reason"],
      },
    },
    suggestRepairerContact: { type: "boolean" },
  },
  required: ["type", "message", "quickFixSteps", "repairMatches", "productMatches", "suggestRepairerContact"],
};

const aiTriage = async (messages, accessories) => {
  const system = `You are the TechNest Repair Assistant — you help someone whose gadget (phone, laptop, tablet, or gaming console) is broken or misbehaving.

1. Ask short, specific diagnostic questions ONE at a time — what device, what exactly happens, did it fall or get wet, sudden or gradual, have they tried a restart. Stop asking once you have enough for a useful answer. When asking, leave the lists empty.
2. Then give a diagnosis with:
   - quickFixSteps: safe DIY steps worth trying before paying for a repair (force restart, check the cable/port for lint, different charger...). Empty if none apply.
   - repairMatches: services from the price list below, by exact id, with a short reason. Prices are ESTIMATES — say so.
   - productMatches: accessories from the in-stock list below, by exact id, only when the problem is clearly a charger/cable/power issue.
   - suggestRepairerContact: true whenever you recommend a paid repair or the issue is beyond simple troubleshooting (water damage, won't turn on, physical damage).
Be concrete and reassuring, not alarmist.

Repair price list (JSON, estimated Nigerian market ranges in naira):
${JSON.stringify(repairServices.map((r) => ({ id: r.id, issue: r.issue, appliesTo: r.appliesTo, priceMin: r.priceMin, priceMax: r.priceMax, note: r.note })))}

Accessories in stock (JSON):
${JSON.stringify(accessories.map((p) => ({ id: p.slug, name: p.name, spec: p.spec, priceUkUsed: p.priceUkUsed })))}`;

  const result = await ai.run({
    feature: "repair_triage",
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    schema: TRIAGE_SCHEMA,
    effort: "medium",
  });
  return result;
};

const enrich = (reply, accessories) => {
  const bySlug = new Map(accessories.map((p) => [p.slug, p]));
  return {
    ...reply,
    repairMatches: reply.repairMatches
      .filter((m) => serviceById.has(m.id))
      .map((m) => ({ ...m, service: serviceById.get(m.id) })),
    productMatches: reply.productMatches
      .filter((m) => bySlug.has(m.id))
      .map((m) => ({ ...m, product: bySlug.get(m.id).toClient() })),
  };
};

/**
 * @swagger
 * /api/repair-triage:
 *   post:
 *     summary: Repair helper chat — works without AI
 *     description: >
 *       Send the conversation (alternating user/assistant, ending with the
 *       user; for assistant turns send `rawReply` from the previous
 *       response). Without AI (`source: rules`) it recognises the device and
 *       problem from keywords and gives quick fixes, matching repair price
 *       ranges and accessories. With AI it asks follow-up questions and
 *       diagnoses. `whatsapp` is the repair partner's number for booking.
 *     tags: [Assistants]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messages]
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     role: { type: string, enum: [user, assistant] }
 *                     content: { type: string }
 *     responses:
 *       200:
 *         description: data.reply { type, message, quickFixSteps, repairMatches[{id, reason, service}], productMatches[{id, reason, product}], suggestRepairerContact }, data.rawReply, data.whatsapp, data.source, data.aiReason
 */
router.post("/", aiSoftLimit, optionalAuth, verifyCsrfIfAuthenticated, async (req, res, next) => {
  try {
    const { messages } = req.body;
    const valid =
      Array.isArray(messages) &&
      messages.length > 0 &&
      messages.length <= 30 &&
      messages.every((m, i) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.trim() && m.content.length <= 6000 && (i > 0 || m.role === "user")) &&
      messages[messages.length - 1].role === "user";
    if (!valid) return sendError(res, 400, "Send messages alternating user/assistant, ending with the user");

    const accessories = await loadAccessories();
    let reply;
    let source = "rules";
    let aiReason = req.aiAllowed ? undefined : "rate_limited";

    if (req.aiAllowed) {
      const result = await aiTriage(messages, accessories);
      if (result.ok) {
        reply = result.data;
        source = "ai";
      } else aiReason = result.reason;
    }
    if (!reply) reply = await rulesTriage(messages);

    sendSuccess(res, 200, "Reply ready", {
      reply: enrich(reply, accessories),
      // Send this back as the assistant turn next time
      rawReply: JSON.stringify(reply),
      whatsapp: SUPPORT_WHATSAPP(),
      source,
      aiReason,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/repair-triage/services:
 *   get:
 *     summary: Estimated repair price list (browse without the chat)
 *     tags: [Assistants]
 *     security: []
 *     responses:
 *       200:
 *         description: data.services, data.whatsapp
 */
router.get("/services", (req, res) => {
  sendSuccess(res, 200, "Repair services", { services: repairServices, whatsapp: SUPPORT_WHATSAPP() });
});

module.exports = router;
