const path = require("path");
const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Tech Nest Intelligence API",
      version: "1.2.0",
      description: [
        "Backend for TechNest — buy, sell and swap gadgets.",
        "",
        "**Auth:** log in with `POST /api/auth/login`; the session lives in httpOnly cookies (`accessToken`, `refreshToken`).",
        "**CSRF:** every POST / PATCH / DELETE made while logged in must send the `X-CSRF-Token` header with the value of the `csrfToken` cookie (also returned by login/register).",
        "**Envelope:** `{ success, message, data }` on success, `{ success: false, message }` on error. Exception: `/api/listings` errors use `{ success: false, error }`.",
        "**Money:** all amounts are Nigerian naira (₦) as whole numbers; Paystack is charged in kobo internally.",
      ].join("\n\n"),
    },
    tags: [
      { name: "Auth" },
      { name: "Me" },
      { name: "Products", description: "Buy catalog (phones and gadgets). Admins manage it." },
      { name: "Checkout", description: "Paystack checkout for the cart, marketplace listings and swap top-ups" },
      { name: "Orders", description: "Order history and buy-again" },
      { name: "Listings", description: "User marketplace listings (sell / swap). New listings need admin approval." },
      { name: "Transactions", description: "Swap / buy / sell deals between users" },
      { name: "Valuation", description: "Device valuation engine and its market base prices" },
      { name: "Assistants", description: "Recommender, site chat and repair helper. All work without AI (free built-in answers); AI improves them when available. Responses say which ran: source = ai | rules." },
      { name: "AI", description: "Whether AI is available right now" },
      { name: "Payouts", description: "Seller bank accounts for split payments" },
      { name: "Vendor" },
      { name: "Notifications" },
      { name: "Uploads" },
      { name: "Admin" },
      { name: "Admin — Prices", description: "Valuation prices: edit by hand, or paste a dealer list (read by AI or the free reader), preview, apply" },
      { name: "Gadgets", description: "Legacy gadget price-tracking (not used by the current frontend)" },
      { name: "Prices", description: "Legacy — see Gadgets" },
      { name: "Devices", description: "Legacy — see Gadgets" },
      { name: "Recommendations", description: "Legacy — see Gadgets. The AI recommender is under Gadget Recommender." },
    ],
    servers: [
      {
        url: process.env.API_URL || "http://localhost:5000",
        description: "API server",
      },
    ],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "accessToken",
        },
        csrfHeader: {
          type: "apiKey",
          in: "header",
          name: "X-CSRF-Token",
          description: "Value of the csrfToken cookie. Required on POST/PATCH/DELETE while logged in.",
        },
      },
      schemas: {
        SuccessResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: true },
            message: { type: "string", example: "Request successful" },
            data: { type: "object" },
          },
        },
        ErrorResponse: {
          type: "object",
          properties: {
            success: { type: "boolean", example: false },
            message: { type: "string", example: "Something went wrong" },
            errors: { type: "object", nullable: true },
          },
        },
      },
    },
    security: [{ cookieAuth: [], csrfHeader: [] }],
  },
  apis: [path.join(__dirname, "..", "routes", "*.js")],
};

module.exports = swaggerJsdoc(options);
