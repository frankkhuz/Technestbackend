// Records every successful change an admin makes, anywhere in the API, so
// there's always an answer to "who approved this?" / "who changed that
// price?". Runs once the response has gone out, so it never slows a
// request or breaks it if the log write fails.
const AuditLog = require("../models/AuditLog");

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const SECRET_KEYS = /pass(word)?|secret|token|signature|apikey/i;
const ID = /^[a-f0-9]{24}$/i;

// Keeps the log useful without storing secrets or huge uploads
const scrub = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}… (${value.length} chars)` : value;
  if (typeof value !== "object") return value;
  if (depth > 3) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 40)) {
    if (SECRET_KEYS.test(k)) out[k] = "[hidden]";
    else if (k === "csv" && typeof v === "string") out[k] = `[CSV, ${v.split(/\r?\n/).length} lines]`;
    else out[k] = scrub(v, depth + 1);
  }
  return out;
};

const auditAdminActions = (req, res, next) => {
  if (!MUTATING.has(req.method)) return next();
  res.on("finish", () => {
    const user = req.user;
    if (!user || user.userType !== "admin" || res.statusCode >= 400) return;
    const path = req.originalUrl.split("?")[0];
    const segments = path.split("/");
    AuditLog.create({
      actor: user._id,
      actorName: user.name,
      method: req.method,
      path,
      action: `${req.method} ${segments.map((s) => (ID.test(s) ? ":id" : s)).join("/")}`,
      targetId: segments.find((s) => ID.test(s)) || null,
      details: req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body) ? scrub(req.body) : null,
      status: res.statusCode,
      ip: req.ip,
    }).catch((err) => console.error("Audit log write failed:", err.message));
  });
  next();
};

module.exports = { auditAdminActions, scrub };
