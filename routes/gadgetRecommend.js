const express = require("express");
const mongoose = require("mongoose");
const Product = require("../models/Product");
const GadgetConversation = require("../models/GadgetConversation");
const { protect, optionalAuth } = require("../middleware/auth");
const { verifyCsrfIfAuthenticated } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const aiSoftLimit = require("../utils/aiSoftLimit");
const ai = require("../utils/ai");
const { parseQueryRules, findProducts, describeFilters } = require("../utils/productSearch");
const router = express.Router();

const MAX_TURNS = 30;
const MAX_MESSAGE_CHARS = 4000;

// ── Catalog context ──────────────────────────────────────────────────────────
// Built from the live Product collection so recommendations track admin edits
// (prices, stock). Sorted deterministically and cached briefly: the system
// prompt is prompt-cached, and any byte change would invalidate that cache.
const CATALOG_TTL_MS = 5 * 60 * 1000;
let catalogCache = { text: null, at: 0 };

const loadCatalogText = async () => {
  if (catalogCache.text && Date.now() - catalogCache.at < CATALOG_TTL_MS)
    return catalogCache.text;

  const products = await Product.find({ isActive: true, inStock: true }).sort({
    type: 1,
    category: 1,
    slug: 1,
  });
  const text = JSON.stringify(
    products.map((p) => ({
      id: p.slug,
      type: p.type,
      name: p.name,
      brand: p.brand,
      category: p.category,
      spec: p.type === "phone" ? [p.storage.join("/"), p.ram].filter(Boolean).join(" · ") : p.spec,
      priceUkUsedNaira: p.priceUkUsed,
      priceBrandNewNaira: p.priceBrandNew,
      tags: p.tags.length ? p.tags : undefined,
    }))
  );
  catalogCache = { text, at: Date.now() };
  return text;
};

const buildSystemPrompt = (catalogText) => `You are the TechNest Gadget Recommender — an expert gadget consultant for TechNest, a Nigerian gadget marketplace that sells UK-used and brand-new phones and gadgets.

A user describes a need in plain language (e.g. "I want 4 cameras for my house", "I need a camera to cover a wedding", "best phone under 500k for photos"). Your job:

1. If the request is ambiguous or you're missing a detail that would change the recommendation (budget, power availability, indoor/outdoor, portability, how many people, experience level, etc.), ask ONE short, specific clarifying question before recommending anything. Don't interrogate — one good question at a time, and only if it would actually change your answer. When asking a question, leave catalogMatches and generalSuggestions empty.
2. Once you have enough to recommend, give a final recommendation covering:
   - catalogMatches: items from TechNest's catalog below that fit, referenced by their exact "id". Only use ids that appear in the catalog — never invent one. Mention whether UK-used or brand-new suits them better when the price gap matters.
   - generalSuggestions: genuinely expert advice even if TechNest doesn't stock it (e.g. "DJI Osmo Pocket 3" for a mobile wedding shoot, or a solar panel + power station if the user has unreliable electricity). TechNest can source items on request, so don't hold back good advice just because it isn't in stock.
3. Explain WHY each suggestion fits their situation — budget, use case, power supply, portability — rather than just listing products. Respect a stated budget: prices are in Nigerian naira (₦).

TechNest's current in-stock catalog (JSON, prices in naira):
${catalogText}`;

// Structured output — the API guarantees the reply matches this schema
const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: ["question", "recommendation"],
      description: "'question' to ask for more info, 'recommendation' when giving suggestions",
    },
    message: {
      type: "string",
      description: "The reply shown to the user — the question itself, or the recommendation explaining the reasoning",
    },
    catalogMatches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, reason: { type: "string" } },
        required: ["id", "reason"],
      },
    },
    generalSuggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, reason: { type: "string" } },
        required: ["name", "reason"],
      },
    },
  },
  required: ["type", "message", "catalogMatches", "generalSuggestions"],
};

// ── Input validation ─────────────────────────────────────────────────────────
const validateMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0)
    return "messages must be a non-empty array";
  if (messages.length > MAX_TURNS * 2)
    return "This conversation is too long — start a new one.";
  for (const [i, m] of messages.entries()) {
    if (!m || typeof m.content !== "string" || !m.content.trim())
      return "Every message needs text content";
    if (m.content.length > MAX_MESSAGE_CHARS * (m.role === "assistant" ? 3 : 1))
      return "That message is too long";
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (m.role !== expected)
      return "Messages must alternate user / assistant, starting and ending with the user";
  }
  if (messages[messages.length - 1].role !== "user")
    return "The last message must be from the user";
  return null;
};

// ── Free recommender (no AI) ────────────────────────────────────────────────
// Reads budget / category / brand from everything the user has said and
// shows the best matching catalog items. Asks one question if it has nothing
// to go on, then shows popular picks rather than asking again.
const rulesRecommend = async (history) => {
  const userText = history.filter((m) => m.role === "user").map((m) => m.content).join(". ");
  const filters = await parseQueryRules(userText);
  const understood = filters.type || filters.category || filters.brand || filters.maxPrice || filters.minPrice;
  const alreadyAsked = history.some((m) => m.role === "assistant");

  if (!understood && !alreadyAsked)
    return {
      type: "question",
      message:
        "Happy to help! What are you shopping for (a phone, laptop, camera, power backup…), what will you mainly use it for, and what's your budget?",
      catalogMatches: [],
      generalSuggestions: [],
    };

  const { products, relaxed } = await findProducts(understood ? filters : { sort: "price-asc" }, { limit: 4 });
  if (!products.length)
    return {
      type: "recommendation",
      message: `I couldn't find anything in stock for ${describeFilters(filters)}. Try a higher budget or a different category — TechNest can also source items on request.`,
      catalogMatches: [],
      generalSuggestions: [],
    };

  const priceField = filters.condition === "brand-new" ? "priceBrandNew" : "priceUkUsed";
  return {
    type: "recommendation",
    message: `Here are the closest matches in stock for ${describeFilters(filters)}${relaxed ? " (I couldn't match every detail, so these are the nearest options)" : ""}.`,
    catalogMatches: products.map((p) => ({
      id: p.slug,
      reason: `${filters.condition === "brand-new" ? "Brand new" : "UK-used"} at ₦${p[priceField].toLocaleString()}${
        p.type === "phone" && p.storage.length ? `, ${p.storage.join("/")}` : p.spec ? `, ${p.spec}` : ""
      }.`,
    })),
    generalSuggestions: [],
  };
};

/**
 * @swagger
 * /api/gadget-recommend:
 *   post:
 *     summary: Ask the AI gadget recommender (guests allowed)
 *     description: >
 *       Send the whole conversation each turn (alternating user/assistant,
 *       ending with the user; assistant turns are the `rawReply` strings from
 *       earlier responses). The recommender either asks one clarifying
 *       question (`reply.type = question`) or recommends
 *       (`reply.type = recommendation`) with catalog products — each match
 *       includes the full `product` — plus general suggestions. Signed-in
 *       users get the conversation saved; pass back `conversationId` to keep
 *       appending to it. Works without AI: `source: rules` means it matched
 *       products on budget / category / brand keywords (see `aiReason` for
 *       why AI wasn't used); `source: ai` is the full AI recommender. Each IP
 *       gets 20 AI replies per 15 min, then falls back to the free version.
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
 *               conversationId: { type: string }
 *     responses:
 *       200:
 *         description: Reply generated
 */
router.post(
  "/",
  aiSoftLimit,
  optionalAuth,
  verifyCsrfIfAuthenticated,
  async (req, res, next) => {
    try {
      const { messages } = req.body;
      const invalid = validateMessages(messages);
      if (invalid) return sendError(res, 400, invalid);
      const history = messages.map((m) => ({ role: m.role, content: m.content.trim() }));

      let conversation = null;
      const { conversationId } = req.body;
      if (conversationId && req.user) {
        if (!mongoose.isValidObjectId(conversationId))
          return sendError(res, 404, "Conversation not found");
        conversation = await GadgetConversation.findOne({
          _id: conversationId,
          user: req.user._id,
        });
        if (!conversation) return sendError(res, 404, "Conversation not found");
      }

      let reply;
      let rawReply;
      let source = "rules";
      let aiReason = req.aiAllowed ? undefined : "rate_limited";

      if (req.aiAllowed) {
        const result = await ai.run({
          feature: "gadget_recommend",
          system: buildSystemPrompt(await loadCatalogText()),
          messages: history,
          schema: REPLY_SCHEMA,
          effort: "medium",
        });
        if (result.ok) {
          reply = result.data;
          rawReply = result.rawText;
          source = "ai";
        } else aiReason = result.reason;
      }
      if (!reply) {
        reply = await rulesRecommend(history);
        rawReply = JSON.stringify(reply);
      }

      // Attach full product data and drop any id that isn't really in the catalog
      const ids = reply.catalogMatches.map((m) => String(m.id).toLowerCase());
      const products = await Product.find({ slug: { $in: ids }, isActive: true });
      const bySlug = new Map(products.map((p) => [p.slug, p]));
      const catalogMatches = reply.catalogMatches
        .filter((m) => bySlug.has(String(m.id).toLowerCase()))
        .map((m) => ({
          id: m.id,
          reason: m.reason,
          product: bySlug.get(String(m.id).toLowerCase()).toClient(),
        }));

      let savedId = conversation ? String(conversation._id) : undefined;
      if (req.user) {
        const fullMessages = [...history, { role: "assistant", content: rawReply }];
        if (conversation) {
          conversation.messages = fullMessages;
          await conversation.save();
        } else {
          const created = await GadgetConversation.create({
            user: req.user._id,
            title: history[0].content.slice(0, 80),
            messages: fullMessages,
          });
          savedId = String(created._id);
        }
      }

      sendSuccess(res, 200, "Reply generated", {
        reply: {
          type: reply.type,
          message: reply.message,
          catalogMatches,
          generalSuggestions: reply.generalSuggestions,
        },
        rawReply,
        conversationId: savedId,
        source,
        aiReason,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /api/gadget-recommend/history:
 *   get:
 *     summary: The signed-in user's saved recommender conversations (latest 30)
 *     tags: [Assistants]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Conversations fetched
 */
router.get("/history", protect, async (req, res, next) => {
  try {
    const conversations = await GadgetConversation.find({ user: req.user._id })
      .select("title updatedAt")
      .sort({ updatedAt: -1 })
      .limit(30);
    sendSuccess(res, 200, "Conversations fetched", {
      conversations: conversations.map((c) => ({
        id: String(c._id),
        title: c.title,
        updatedAt: c.updatedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/gadget-recommend/{id}:
 *   get:
 *     summary: One saved recommender conversation with all messages
 *     tags: [Assistants]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Conversation fetched
 *       404:
 *         description: Not found
 *   delete:
 *     summary: Delete a saved recommender conversation
 *     tags: [Assistants]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Conversation deleted
 */
router.get("/:id", protect, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Not found");
    const c = await GadgetConversation.findOne({ _id: req.params.id, user: req.user._id });
    if (!c) return sendError(res, 404, "Not found");
    sendSuccess(res, 200, "Conversation fetched", {
      id: String(c._id),
      title: c.title,
      messages: c.messages,
    });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", protect, verifyCsrfIfAuthenticated, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Not found");
    const c = await GadgetConversation.findOneAndDelete({
      _id: req.params.id,
      user: req.user._id,
    });
    if (!c) return sendError(res, 404, "Not found");
    sendSuccess(res, 200, "Conversation deleted", { id: String(c._id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
