const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const connectDB = require("./config/db");

const gadgetRoutes = require("./routes/gadgets");
const priceRoutes = require("./routes/prices");
const deviceRoutes = require("./routes/devices");
const recommendRoutes = require("./routes/recommendations");
const authRoutes = require("./routes/auth");

const app = express();

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.CLIENT_URL,
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: "10kb" })); // prevent oversized payloads

// ─── General Rate Limiter ─────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
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
  const isDev = process.env.NODE_ENV === "development";
  res.status(err.status || 500).json({
    error: isDev ? err.message : "Something went wrong",
  });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
