// The server loads .env, but only for variables that aren't already set —
// so every suite starts from this base, which blanks every outside service
// (a real email or payment key in .env must never be used by a test) and
// preloads the fetch mock, which refuses any other call to the internet.
const path = require("path");

const OUTSIDE_SERVICES = [
  "ANTHROPIC_API_KEY",
  "PAYSTACK_SECRET_KEY",
  "EMAIL_PROVIDER",
  "EMAIL_API_KEY",
  "EMAIL_FROM",
  "WHATSAPP_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_NUMBER",
  "WHATSAPP_VERIFY_TOKEN",
  "INTERNAL_CRON_SECRET",
  "ONLINE_PAYMENTS",
  "CLIENT_URL",
];

const baseEnv = () => ({
  ...process.env,
  ...Object.fromEntries(OUTSIDE_SERVICES.map((k) => [k, ""])),
  NODE_OPTIONS: `--require ${path.join(__dirname, "mock-fetch.js")}`,
});

module.exports = { baseEnv };
