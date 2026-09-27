const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const connectDB = require("./config/db");
const sanitizeRequest = require("./middleware/sanitize");
const { sendError } = require("./utils/response");

const gadgetRoutes = require("./routes/gadgets");
const priceRoutes = require("./routes/prices");
const deviceRoutes = require("./routes/devices");
const recommendRoutes = require("./routes/recommendations");
const authRoutes = require("./routes/auth");
const listingRoutes = require("./routes/listings");
const vendorRoutes = require("./routes/vendor");
const meRoutes = require("./routes/me");
const adminRoutes = require("./routes/admin");
const uploadRoutes = require("./routes/uploads");
const notificationRoutes = require("./routes/notifications");
const productRoutes = require("./routes/products");
const checkoutRoutes = require("./routes/checkout");
const orderRoutes = require("./routes/orders");
const transactionRoutes = require("./routes/transactions");
const payoutRoutes = require("./routes/payout");
const valuationRoutes = require("./routes/valuation");
const gadgetRecommendRoutes = require("./routes/gadgetRecommend");
const supportRoutes = require("./routes/support");
const repairTriageRoutes = require("./routes/repairTriage");
const aiStatusRoutes = require("./routes/aiStatus");
const adminPriceRoutes = require("./routes/adminPrices");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./config/swagger");

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error(
    "JWT_SECRET is missing or too short. Set a random 32+ character string in .env"
  );
  process.exit(1);
}

if (
  !process.env.JWT_REFRESH_SECRET ||
  process.env.JWT_REFRESH_SECRET.length < 32
) {
  console.error(
    "JWT_REFRESH_SECRET is missing or too short. Set a random 32+ character string in .env"
  );
  process.exit(1);
}

if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  console.error(
    "Cloudinary env vars missing. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in .env"
  );
  process.exit(1);
}

if (!process.env.PAYSTACK_SECRET_KEY) {
  console.warn(
    "PAYSTACK_SECRET_KEY is not set — checkout and seller payouts will return 503 until it is."
  );
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "ANTHROPIC_API_KEY is not set — AI extras are off; every feature uses its free built-in version."
  );
}

const app = express();
app.set("trust proxy", 1);

const allowedOrigins = [
  process.env.CLIENT_URL,
  "https://technest11.vercel.app",
  "http://localhost:3000",
  "http://localhost:5173",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  })
);

app.use(helmet());

// Paystack webhook needs the raw body to verify its signature, so it's
// registered before the JSON parser (and before the rate limiter — Paystack
// retries on failure and shouldn't be throttled like a browser).
app.post(
  "/api/checkout/webhook",
  express.raw({ type: "application/json", limit: "100kb" }),
  checkoutRoutes.webhookHandler
);

app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());
app.use(sanitizeRequest);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  handler: (req, res) => sendError(res, 429, "Too many requests, slow down."),
});
app.use("/api/", limiter);

app.use("/api/gadgets", gadgetRoutes);
app.use("/api/prices", priceRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/recommendations", recommendRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/listings", listingRoutes);
app.use("/api/vendors", vendorRoutes);
// The frontend dashboard calls /api/vendor/inventory and /api/vendor/bid
app.use("/api/vendor", vendorRoutes);
app.use("/api/me", meRoutes);
app.use("/api/admin/prices", adminPriceRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/products", productRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/payout-account", payoutRoutes);
app.use("/api/valuation", valuationRoutes);
app.use("/api/gadget-recommend", gadgetRecommendRoutes);
app.use("/api/chat", supportRoutes);
app.use("/api/repair-triage", repairTriageRoutes);
app.use("/api/ai", aiStatusRoutes);
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.get("/", (req, res) => {
  res.json({ status: "Tech Nest Intelligence API is live 🚀" });
});

app.use((req, res) => {
  sendError(res, 404, "Route not found");
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  const isDev = process.env.NODE_ENV === "development";
  sendError(
    res,
    err.status || 500,
    isDev ? err.message : "Something went wrong"
  );
});

const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  try {
    await require("./utils/valuation").reloadDevices();
  } catch (err) {
    // Valuation falls back to the bundled JSON prices until this succeeds
    console.error("Could not load valuation devices:", err.message);
  }
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
