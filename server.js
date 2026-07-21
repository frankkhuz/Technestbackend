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
app.use("/api/me", meRoutes);
app.use("/api/admin", adminRoutes);
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

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
