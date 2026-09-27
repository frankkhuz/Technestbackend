// The one place the app talks to Claude.
//
// AI is always optional in TechNest: every feature has a manual/rules path
// that works with no AI at all, and AI only improves on it. So nothing here
// ever throws — `run()` returns { ok: true, data } or { ok: false, reason }
// and the caller falls back to its manual path on any failure.
//
// AI is skipped when:
//   - ANTHROPIC_API_KEY isn't set                        reason "not_configured"
//   - an admin switched it off (PATCH /api/admin/ai)     reason "disabled"
//   - the daily call cap (AI_DAILY_LIMIT) is reached     reason "daily_limit"
//   - it recently failed hard and is cooling off         reason "paused"
// Hard failures pause AI for everyone so we don't hammer a dead API:
//   out of credit (402) or bad key (401/403) → 30 min; overloaded / rate
//   limited / server errors → 1 min.
const Anthropic = require("@anthropic-ai/sdk").default;
const AppSetting = require("../models/AppSetting");
const AiUsage = require("../models/AiUsage");

const MODEL = "claude-opus-5";
const LONG_PAUSE_MS = 30 * 60 * 1000;
const SHORT_PAUSE_MS = 60 * 1000;
const SETTINGS_TTL_MS = 30 * 1000;

let client = null;
let pause = { until: 0, reason: null };
let settingsCache = { enabled: true, at: 0 };

const getClient = () => {
  if (!client)
    client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 60 * 1000,
      maxRetries: 1,
    });
  return client;
};

const dailyLimit = () => Number(process.env.AI_DAILY_LIMIT || 500);
const today = () => new Date().toISOString().slice(0, 10);

const adminEnabled = async () => {
  if (Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.enabled;
  try {
    const doc = await AppSetting.findOne({ key: "ai.enabled" });
    settingsCache = { enabled: doc ? doc.value !== false : true, at: Date.now() };
  } catch {
    settingsCache = { enabled: true, at: Date.now() };
  }
  return settingsCache.enabled;
};

const setAdminEnabled = async (enabled) => {
  await AppSetting.findOneAndUpdate(
    { key: "ai.enabled" },
    { key: "ai.enabled", value: !!enabled },
    { upsert: true }
  );
  settingsCache = { enabled: !!enabled, at: Date.now() };
  if (enabled) pause = { until: 0, reason: null }; // switching on also clears a pause
};

const callsToday = async () => {
  try {
    const rows = await AiUsage.find({ day: today() });
    return rows.reduce((s, r) => s + r.calls, 0);
  } catch {
    return 0;
  }
};

/** Whether AI can be used right now, and if not, why. */
const getStatus = async () => {
  if (!process.env.ANTHROPIC_API_KEY) return { enabled: false, reason: "not_configured" };
  if (!(await adminEnabled())) return { enabled: false, reason: "disabled" };
  if (pause.until > Date.now())
    return { enabled: false, reason: "paused", pausedBecause: pause.reason, pausedUntil: new Date(pause.until).toISOString() };
  if ((await callsToday()) >= dailyLimit()) return { enabled: false, reason: "daily_limit" };
  return { enabled: true, reason: null };
};

const record = async (feature, fields) => {
  try {
    await AiUsage.updateOne(
      { day: today(), feature },
      { $inc: fields },
      { upsert: true }
    );
  } catch {
    // Usage stats are nice-to-have; never fail a request over them
  }
};

const classifyError = (error) => {
  if (error instanceof Anthropic.APIError) {
    if (error.status === 402 || error.type === "billing_error")
      return { reason: "out_of_credit", pauseMs: LONG_PAUSE_MS };
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
      return { reason: "misconfigured", pauseMs: LONG_PAUSE_MS };
    if (error instanceof Anthropic.RateLimitError || error.status === 529 || error.type === "overloaded_error")
      return { reason: "busy", pauseMs: SHORT_PAUSE_MS };
    if (error instanceof Anthropic.BadRequestError) return { reason: "error", pauseMs: 0 };
    return { reason: "error", pauseMs: SHORT_PAUSE_MS }; // 5xx, connection, timeout
  }
  return { reason: "error", pauseMs: 0 };
};

/**
 * Ask Claude for a JSON answer matching `schema`.
 * @returns {Promise<{ok: true, data: object, rawText: string} | {ok: false, reason: string}>}
 */
const run = async ({
  feature,
  system,
  messages,
  schema,
  effort = "medium",
  maxTokens = 16000,
}) => {
  const status = await getStatus();
  if (!status.enabled) return { ok: false, reason: status.reason };

  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      // A safety-classifier decline is retried on the recommended fallback
      // model server-side instead of failing
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Cached so repeated calls with the same instructions/catalog are cheaper
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      output_config: { effort, format: { type: "json_schema", schema } },
      messages,
    });
  } catch (error) {
    const { reason, pauseMs } = classifyError(error);
    if (pauseMs) pause = { until: Date.now() + pauseMs, reason };
    console.warn(`[ai] ${feature} failed (${reason}):`, error.status || "", error.message);
    await record(feature, { failures: 1 });
    return { ok: false, reason };
  }

  const usage = response.usage || {};
  await record(feature, {
    calls: 1,
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheWriteTokens: usage.cache_creation_input_tokens || 0,
  });

  if (response.stop_reason === "refusal") return { ok: false, reason: "declined" };
  if (response.stop_reason === "max_tokens") return { ok: false, reason: "error" };

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  try {
    return { ok: true, data: JSON.parse(text), rawText: text };
  } catch {
    return { ok: false, reason: "error" };
  }
};

// Claude Opus 5 list prices, USD per million tokens — for the admin usage estimate
const PRICES = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const estimateCostUsd = (u) =>
  ((u.inputTokens || 0) * PRICES.input +
    (u.outputTokens || 0) * PRICES.output +
    (u.cacheReadTokens || 0) * PRICES.cacheRead +
    (u.cacheWriteTokens || 0) * PRICES.cacheWrite) /
  1e6;

// For tests
const _reset = () => {
  pause = { until: 0, reason: null };
  settingsCache = { enabled: true, at: 0 };
  client = null;
};

module.exports = {
  MODEL,
  run,
  getStatus,
  setAdminEnabled,
  dailyLimit,
  estimateCostUsd,
  _reset,
};
