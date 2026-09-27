// Per-IP limit on how often a visitor can make public AI calls. Unlike a
// normal rate limit it never blocks the request — over the limit, the route
// just skips AI (req.aiAllowed = false) and answers with its free path.
const rateLimit = require("express-rate-limit");

const aiSoftLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AI_PER_IP_LIMIT || 20),
  standardHeaders: false,
  legacyHeaders: false,
  handler: (req, res, next) => {
    req.aiAllowed = false;
    next();
  },
});

const markAllowed = (req, res, next) => {
  if (req.aiAllowed !== false) req.aiAllowed = true;
  next();
};

module.exports = [aiSoftLimit, markAllowed];
