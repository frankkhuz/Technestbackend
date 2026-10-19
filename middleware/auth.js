const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { sendError } = require("../utils/response");
const email = require("../utils/email");

const protect = async (req, res, next) => {
  const token = req.cookies?.accessToken;
  if (!token) return sendError(res, 401, "Not authorized");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");

    if (!req.user) return sendError(res, 401, "User no longer exists");

    next();
  } catch {
    sendError(res, 401, "Invalid or expired token");
  }
};

// Like protect, but lets guests through with req.user = null. For routes that
// work for everyone but do more (e.g. save history) for signed-in users.
const optionalAuth = async (req, res, next) => {
  req.user = null;
  const token = req.cookies?.accessToken;
  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");
  } catch {
    // Expired/invalid token — treat as a guest rather than failing the request
  }
  next();
};

const restrictTo =
  (...types) =>
  (req, res, next) => {
    if (!req.user || !types.includes(req.user.userType))
      return sendError(res, 403, "Not permitted for this account type");
    next();
  };

// Until an email provider is configured nobody could verify, so the check
// stays off rather than locking every account out. Both `message` and
// `error` are set because /api/listings errors use `error`; `code` lets the
// frontend show a "resend link" button.
const requireVerified = (req, res, next) => {
  if (req.user.isVerified || req.user.userType === "admin" || !email.isConfigured())
    return next();
  const message =
    "Please confirm your email first — check your inbox for our link, or ask for a new one.";
  res.status(403).json({ success: false, message, error: message, code: "email_not_verified" });
};

const requireVendorVerified = (req, res, next) => {
  if (req.user.userType !== "vendor")
    return sendError(res, 403, "Vendor account required");
  if (!req.user.vendorVerified)
    return sendError(res, 403, "Complete vendor verification to continue");
  next();
};

module.exports = {
  protect,
  optionalAuth,
  restrictTo,
  requireVerified,
  requireVendorVerified,
};
