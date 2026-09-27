const express = require("express");
const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const Listing = require("../models/Listing");
const { optionalAuth } = require("../middleware/auth");
const { verifyCsrfIfAuthenticated } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const aiSoftLimit = require("../utils/aiSoftLimit");
const ai = require("../utils/ai");
const {
  FAQ,
  GREETING,
  ACCOUNT_QUESTION,
  ALLOWED_LINKS,
  SUPPORT_WHATSAPP,
} = require("../utils/supportFaq");
const router = express.Router();

const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

// What the signed-in user has going on — used by both the free answers and AI
const loadAccount = async (user) => {
  if (!user) return null;
  const [orders, deals, listings] = await Promise.all([
    Order.find({ buyer: user._id, status: { $ne: "cancelled" } }).sort({ createdAt: -1 }).limit(5),
    Transaction.find({
      $or: [{ buyer: user._id }, { seller: user._id }],
      status: { $in: ["pending", "accepted"] },
    }).sort({ updatedAt: -1 }).limit(5),
    Listing.find({ owner: user._id, status: { $in: ["pending_review", "active", "rejected"] } })
      .sort({ updatedAt: -1 })
      .limit(5),
  ]);
  return {
    name: user.name,
    orders: orders.map((o) => {
      const c = o.toClient();
      return {
        reference: c.reference,
        item: c.itemName,
        amount: c.amount,
        payment: c.status,
        delivery: c.fulfillmentStatus,
        date: c.createdAt.slice(0, 10),
      };
    }),
    deals: deals.map((t) => ({
      type: t.type,
      device: t.listingDeviceName,
      youAre: t.buyer.toString() === user._id.toString() ? "buyer" : "seller",
      status: t.status,
      topUpDue: t.topUpAmount > 0 && !t.topUpPaid ? t.topUpAmount : 0,
    })),
    listings: listings.map((l) => ({
      device: l.deviceName,
      status: l.status,
      offers: l.bids.length,
      rejectionReason: l.rejectionReason || undefined,
    })),
  };
};

const ORDER_WORDS = /\b(order|orders|deliver\w*|ship\w*|paid|payment|track\w*|bought|purchase)\b/i;
const DEAL_WORDS = /\b(swap|swaps|deal|deals|offer|top[- ]?up|request)\b/i;
const LISTING_WORDS = /\b(listing|listings|approved|approval|pending|rejected|live|sell)\b/i;

const LISTING_STATUS = {
  pending_review: "waiting for admin approval",
  active: "live",
  rejected: "not approved",
};

// The free answer: account status if they asked about theirs, else the FAQ
const rulesReply = (text, account) => {
  const whatsapp = SUPPORT_WHATSAPP();
  const lines = [];
  const links = [];

  if (account && ACCOUNT_QUESTION.test(text)) {
    if (ORDER_WORDS.test(text)) {
      if (!account.orders.length) lines.push("You don't have any orders yet.");
      else
        lines.push(
          "Your latest orders:\n" +
            account.orders
              .map((o) => `• ${o.item} (${naira(o.amount)}) — payment ${o.payment}${o.payment === "paid" ? `, delivery ${o.delivery}` : ""} · ref ${o.reference}`)
              .join("\n")
        );
      links.push({ label: "My account", href: "/user" });
    }
    if (DEAL_WORDS.test(text)) {
      if (!account.deals.length) lines.push("You don't have any open swaps or deals.");
      else
        lines.push(
          "Your open deals:\n" +
            account.deals
              .map((d) => `• ${d.type} — ${d.device}: ${d.status}${d.topUpDue ? ` (top-up of ${naira(d.topUpDue)} still to pay)` : ""}`)
              .join("\n")
        );
      links.push({ label: "My deals", href: "/transactions" });
    }
    if (LISTING_WORDS.test(text) && !ORDER_WORDS.test(text)) {
      if (!account.listings.length) lines.push("You don't have any open listings.");
      else
        lines.push(
          "Your listings:\n" +
            account.listings
              .map((l) => `• ${l.device}: ${LISTING_STATUS[l.status] || l.status}${l.offers ? `, ${l.offers} offer(s)` : ""}${l.rejectionReason ? ` — ${l.rejectionReason}` : ""}`)
              .join("\n")
        );
      links.push({ label: "My account", href: "/user" });
    }
  } else if (!account && ACCOUNT_QUESTION.test(text)) {
    lines.push("Sign in and ask again, and I'll look up your orders, deals and listings.");
    links.push({ label: "Sign in", href: "/auth/login" });
  }

  if (!lines.length) {
    const hits = FAQ.filter((f) => f.match.test(text)).slice(0, 2);
    for (const h of hits) {
      lines.push(h.answer);
      links.push(...h.links);
    }
  }

  if (!lines.length) {
    if (GREETING.test(text))
      lines.push("Hi! I can help with buying, selling, swapping, payments, deliveries and repairs. What do you need?");
    else
      lines.push(
        `I'm not sure about that one. I can help with buying, selling, swapping, payments, deliveries, IMEI and battery checks, and repairs — or you can reach a person on WhatsApp: +${whatsapp}.`
      );
  }

  const seen = new Set();
  return {
    reply: lines.join("\n\n"),
    links: links.filter((l) => !seen.has(l.href) && seen.add(l.href)),
  };
};

const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    links: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { label: { type: "string" }, href: { type: "string" } },
        required: ["label", "href"],
      },
    },
  },
  required: ["reply", "links"],
};

const validMessages = (messages) =>
  Array.isArray(messages) &&
  messages.length > 0 &&
  messages.length <= 40 &&
  messages.every(
    (m, i) =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.trim() &&
      m.content.length <= 4000 &&
      (i > 0 || m.role === "user")
  ) &&
  messages[messages.length - 1].role === "user";

/**
 * @swagger
 * /api/chat:
 *   post:
 *     summary: Site help chat — works without AI
 *     description: >
 *       Answers questions about using TechNest. Signed-in users can ask about
 *       their own orders, swaps/deals and listings ("where is my order?").
 *       Without AI (`source: rules`) it answers from a built-in FAQ and the
 *       user's account data; with AI it holds a natural conversation using the
 *       same facts. `links` are in-app pages to show as buttons.
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
 *         description: data.reply (text), data.links[], data.whatsapp, data.source (ai | rules), data.aiReason
 */
router.post("/", aiSoftLimit, optionalAuth, verifyCsrfIfAuthenticated, async (req, res, next) => {
  try {
    const { messages } = req.body;
    if (!validMessages(messages))
      return sendError(res, 400, "Send messages alternating user/assistant, ending with the user");

    const lastUser = messages[messages.length - 1].content;
    const account = await loadAccount(req.user);
    const whatsapp = SUPPORT_WHATSAPP();

    let aiReason = req.aiAllowed ? undefined : "rate_limited";
    if (req.aiAllowed) {
      const system = `You are the TechNest assistant — a friendly, concise helper for TechNest, a Nigerian marketplace for buying, selling and swapping gadgets.

Keep answers short (2–4 sentences unless asked for detail), friendly and specific to TechNest. Use only the facts below. For the user's own orders, deals and listings, use only the account data given — never invent account details; if something isn't there, say so and suggest their account page or WhatsApp support (+${whatsapp}).

links: up to 3 in-app pages that help, chosen only from: ${JSON.stringify([...ALLOWED_LINKS])}.

How TechNest works:
${FAQ.map((f) => `- ${f.answer}`).join("\n")}`;

      const result = await ai.run({
        feature: "support_chat",
        system,
        messages: [
          ...messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
          {
            role: "user",
            content: `${lastUser}\n\n[Account data — ${account ? JSON.stringify(account) : "the user is not signed in"}]`,
          },
        ],
        schema: CHAT_SCHEMA,
        effort: "low",
        maxTokens: 4000,
      });
      if (result.ok)
        return sendSuccess(res, 200, "Reply ready", {
          reply: result.data.reply,
          links: result.data.links.filter((l) => ALLOWED_LINKS.has(l.href)).slice(0, 3),
          whatsapp,
          source: "ai",
        });
      aiReason = result.reason;
    }

    const { reply, links } = rulesReply(lastUser, account);
    sendSuccess(res, 200, "Reply ready", { reply, links, whatsapp, source: "rules", aiReason });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
