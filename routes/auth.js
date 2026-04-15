const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const router = express.Router();

// ─── Strict limiter for auth endpoints ───────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // only 10 attempts per window
  message: { error: "Too many attempts, please try again later." },
});

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });

// POST /api/auth/register
router.post("/register", authLimiter, async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.status(400).json({ error: "All fields required" });

    // Basic email format check
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email))
      return res.status(400).json({ error: "Invalid email format" });

    // Enforce minimum password length
    if (password.length < 6)
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: "Email already in use" });

    const user = await User.create({ name, email, password });
    res.status(201).json({
      token: signToken(user._id),
      user: { id: user._id, name, email },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "Email and password required" });

    const user = await User.findOne({ email });
    if (!user || !(await user.matchPassword(password)))
      return res.status(401).json({ error: "Invalid credentials" });

    res.json({
      token: signToken(user._id),
      user: { id: user._id, name: user.name, email },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
