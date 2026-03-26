const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const gadgetRoutes = require("./routes/gadgets");
const priceRoutes = require("./routes/prices");
const deviceRoutes = require("./routes/devices");
const recommendRoutes = require("./routes/recommendations");
const authRoutes = require("./routes/auth");

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL || "*" }));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: "Too many requests, slow down." },
});
app.use("/api/", limiter);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/gadgets", gadgetRoutes);
app.use("/api/prices", priceRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/recommendations", recommendRoutes);
app.use("/api/auth", authRoutes);

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Tech Nest Intelligence API is live 🚀" });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
