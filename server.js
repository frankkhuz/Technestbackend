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
const imeiRoutes = require("./routes/imei");
const adminImeiRoutes = require("./routes/adminImei");
const orderRequestRoutes = require("./routes/orderRequests");
const adminOrderRequestRoutes = require("./routes/adminOrderRequests");
const identityRoutes = require("./routes/identity");
const adminIdentityRoutes = require("./routes/adminIdentity");
const deviceRequestRoutes = require("./routes/deviceRequests");
const adminDeviceRequestRoutes = require("./routes/adminDeviceRequests");
const internalRoutes = require("./routes/internal");
const categoryRoutes = require("./routes/categories");
const adminAnnouncementRoutes = require("./routes/adminAnnouncements");
const phoneRoutes = require("./routes/phone");
const adminUserRoutes = require("./routes/adminUsers");
const whatsappWebhook = require("./routes/whatsapp");
const healthRoutes = require("./routes/health");
const adminFinanceRoutes = require("./routes/adminFinance");
const reviewRoutes = require("./routes/reviews");
const { requireDatabase, errorHandler } = require("./middleware/errors");
const mongoose = require("mongoose");
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

// Keys the IMEI hashes used for duplicate/stolen matching (utils/imei.js).
// Never change it once set — every stored IMEI hash would stop matching.
if (!process.env.IMEI_HASH_SECRET || process.env.IMEI_HASH_SECRET.length < 32) {
  console.error(
    "IMEI_HASH_SECRET is missing or too short. Set a random 32+ character string in .env (and never change it afterwards)"
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

if (!require("./utils/email").isConfigured()) {
  console.warn(
    "Email is not configured (EMAIL_PROVIDER, EMAIL_API_KEY, EMAIL_FROM) — emails are logged instead of sent, and email verification isn't enforced."
  );
}
if (!require("./utils/whatsapp").isConfigured()) {
  console.warn(
    "WhatsApp Cloud API is not configured — phone numbers are verified by staff from the admin panel."
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
// WhatsApp Cloud API webhook — same reasons as Paystack's above
app.get("/api/whatsapp/webhook", whatsappWebhook.verifyHandler);
app.post(
  "/api/whatsapp/webhook",
  express.raw({ type: "application/json", limit: "200kb" }),
  whatsappWebhook.webhookHandler
);

// CSV uploads need more room than the 10kb every other route gets. These
// run first; the general parser below skips bodies already parsed.
app.use("/api/products/bulk", express.json({ limit: "2mb" }));
app.use(["/api/vendor/inventory/bulk", "/api/vendors/inventory/bulk"], express.json({ limit: "1mb" }));
app.use("/api/admin/imei/tac/import", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());
app.use(sanitizeRequest);

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  handler: (req, res) => sendError(res, 429, "Too many requests, slow down."),
});
// Health first: monitors must always get an answer, even when rate-limited
// or the database is down
app.use("/api/health", healthRoutes);
app.use("/api/", limiter);
// Answer straight away while the database is unreachable (docs still load)
app.use("/api", (req, res, next) => (req.path.startsWith("/docs") ? next() : requireDatabase(req, res, next)));

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
app.use("/api/admin/imei", adminImeiRoutes);
app.use("/api/imei", imeiRoutes);
app.use("/api/admin/order-requests", adminOrderRequestRoutes);
app.use("/api/order-requests", orderRequestRoutes);
app.use("/api/admin/identity", adminIdentityRoutes);
app.use("/api/identity", identityRoutes);
app.use("/api/admin/requests", adminDeviceRequestRoutes);
app.use("/api/requests", deviceRequestRoutes);
app.use("/api/internal", internalRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/admin/announcements", adminAnnouncementRoutes);
app.use("/api/phone", phoneRoutes);
app.use("/api/admin/users", adminUserRoutes);
app.use("/api/admin/finance", adminFinanceRoutes);
app.use("/api/reviews", reviewRoutes);
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

app.use(errorHandler);

// A stray rejected promise (e.g. a background email) must not take the
// whole server down — log it and carry on
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason instanceof Error ? reason.stack : reason);
});
mongoose.connection.on("disconnected", () => console.error("MongoDB disconnected — answering 503 until it's back"));
mongoose.connection.on("reconnected", () => console.log("MongoDB reconnected"));

const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
  try {
    await require("./utils/valuation").reloadDevices();
  } catch (err) {
    // Valuation falls back to the bundled JSON prices until this succeeds
    console.error("Could not load valuation devices:", err.message);
  }
  try {
    const added = await require("./utils/categories").ensureDefaultCategories();
    if (added) console.log(`Added ${added} default product categories`);
  } catch (err) {
    console.error("Could not create default categories:", err.message);
  }
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
