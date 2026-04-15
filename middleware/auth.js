// ─── middleware/auth.js ───────────────────────────────────────────────────────
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const protect = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Not authorized" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select("-password");

    // User may have been deleted after token was issued
    if (!req.user)
      return res.status(401).json({ error: "User no longer exists" });

    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

module.exports = { protect };
