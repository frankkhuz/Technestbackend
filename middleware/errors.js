// Clear answers when something goes wrong, instead of a hang or a bare
// "Something went wrong". Every error response keeps the usual
// { success: false, message } shape and adds a `code` the frontend can
// act on (e.g. show a "try again" button for service_unavailable).
const mongoose = require("mongoose");

const RETRY_SECONDS = 30;

const unavailable = (res, message) => {
  res.set("Retry-After", String(RETRY_SECONDS));
  return res.status(503).json({
    success: false,
    message: message || "TechNest is having a temporary problem. Please try again in a minute.",
    code: "service_unavailable",
    retryAfter: RETRY_SECONDS,
  });
};

// Mongoose queues queries while the database is unreachable and only fails
// them after ~10s — answer straight away instead
const requireDatabase = (req, res, next) =>
  mongoose.connection.readyState === 1 ? next() : unavailable(res);

const isDatabaseDown = (err) =>
  /^Mongo(Network|ServerSelection|NotConnected)/.test(err?.name || "") ||
  /buffering timed out|ECONNREFUSED|topology was destroyed/i.test(err?.message || "");

// The last middleware: turns errors into answers people can act on
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const send = (status, message, code, extra = {}) =>
    res.status(status).json({ success: false, message, code, errors: null, ...extra });

  if (err.type === "entity.too.large") return send(413, "That upload is too big.", "too_large");
  if (err.type === "entity.parse.failed") return send(400, "The request wasn't valid JSON.", "bad_json");
  if (err.name === "ValidationError")
    return send(400, Object.values(err.errors || {}).map((e) => e.message).join(" ") || "Some details aren't valid.", "invalid");
  if (err.name === "CastError") return send(400, `Invalid ${err.path || "value"}.`, "invalid");
  if (err.code === 11000) return send(409, "That already exists.", "duplicate");
  if (err.message === "Not allowed by CORS") return send(403, "This website isn't allowed to use the TechNest API.", "cors");
  if (isDatabaseDown(err)) {
    console.error(`Database unavailable: ${err.message}`);
    return unavailable(res);
  }

  console.error(err.stack || err);
  const isDev = process.env.NODE_ENV === "development";
  send(err.status || 500, isDev ? err.message : "Something went wrong on our side. Please try again.", "server_error");
};

module.exports = { requireDatabase, errorHandler, unavailable };
