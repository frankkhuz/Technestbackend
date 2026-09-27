const crypto = require("crypto");

const PAYSTACK_BASE = "https://api.paystack.co";

const isConfigured = () => !!process.env.PAYSTACK_SECRET_KEY;

const paystackRequest = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !!data.status, data };
};

/**
 * Starts a Paystack transaction and returns the hosted checkout URL.
 * `split` routes the seller's share to their subaccount — the platform
 * keeps `platformFeeKobo` and bears Paystack's own fee.
 */
const initializeTransaction = async ({
  email,
  amountNaira,
  reference,
  metadata,
  split,
}) => {
  const clientUrl = (process.env.CLIENT_URL || "https://technest11.vercel.app").replace(/\/$/, "");
  const payload = {
    email,
    amount: Math.round(amountNaira * 100), // kobo
    reference,
    callback_url: `${clientUrl}/checkout/callback`,
    metadata,
  };
  if (split) {
    payload.subaccount = split.subaccountCode;
    payload.transaction_charge = split.platformFeeKobo;
    payload.bearer = "account";
  }

  const { ok, data } = await paystackRequest("/transaction/initialize", {
    method: "POST",
    body: payload,
  });
  if (!ok) return { error: data.message || "Could not start checkout. Try again." };
  return { authorizationUrl: data.data.authorization_url };
};

/** Returns { paid, amountKobo } for a reference, or { error } */
const verifyTransaction = async (reference) => {
  const { ok, data } = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`
  );
  if (!ok) return { error: data.message || "Could not verify payment." };
  return {
    paid: data.data?.status === "success",
    status: data.data?.status,
    amountKobo: data.data?.amount,
  };
};

let cachedBanks = null;
let cachedAt = 0;
const BANK_CACHE_MS = 60 * 60 * 1000;

const listBanks = async () => {
  if (cachedBanks && Date.now() - cachedAt < BANK_CACHE_MS) return { banks: cachedBanks };
  const { ok, data } = await paystackRequest("/bank?country=nigeria&currency=NGN");
  if (!ok) return { error: "Could not load bank list." };
  cachedBanks = data.data.map((b) => ({ id: b.id, name: b.name, code: b.code }));
  cachedAt = Date.now();
  return { banks: cachedBanks };
};

const resolveAccount = async (accountNumber, bankCode) => {
  const { ok, data } = await paystackRequest(
    `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`
  );
  if (!ok) return { error: data.message || "Could not verify that account number." };
  return { accountName: data.data.account_name };
};

const createSubaccount = async ({ businessName, bankCode, accountNumber, percentageCharge }) => {
  const { ok, data } = await paystackRequest("/subaccount", {
    method: "POST",
    body: {
      business_name: businessName,
      settlement_bank: bankCode,
      account_number: accountNumber,
      percentage_charge: percentageCharge,
    },
  });
  if (!ok) return { error: data.message || "Could not set up your payout account." };
  return { subaccountCode: data.data.subaccount_code };
};

// Paystack signs webhook bodies with HMAC-SHA512 of the raw body using the
// secret key. Compare in constant time.
const isValidWebhookSignature = (rawBody, signature) => {
  if (!rawBody || !signature || !isConfigured()) return false;
  const expected = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = {
  isConfigured,
  initializeTransaction,
  verifyTransaction,
  listBanks,
  resolveAccount,
  createSubaccount,
  isValidWebhookSignature,
};
