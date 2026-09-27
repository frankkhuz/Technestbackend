const crypto = require("crypto");
const { sendError } = require("../utils/response");

const issueCsrfToken = (req, res, next) => {
  const token = crypto.randomBytes(32).toString("hex");
  res.cookie("csrfToken", token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  req.csrfToken = token;
  next();
};

const verifyCsrfToken = (req, res, next) => {
  const cookieToken = req.cookies.csrfToken;
  const headerToken = req.headers["x-csrf-token"];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return sendError(res, 403, "Invalid CSRF token");
  }
  next();
};

// For routes open to guests: cookie-authenticated requests still need the
// CSRF header (that's where CSRF risk comes from), guests don't have one.
const verifyCsrfIfAuthenticated = (req, res, next) =>
  req.user ? verifyCsrfToken(req, res, next) : next();

module.exports = { issueCsrfToken, verifyCsrfToken, verifyCsrfIfAuthenticated };
