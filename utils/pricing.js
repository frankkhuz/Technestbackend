// Money-math for marketplace-listing checkouts, where the buyer pays the
// seller's asking price PLUS a platform markup that covers Paystack's
// processing fee and TechNest's commission. Ported from the frontend's
// app/lib/paystackFees.ts so the preview and the real charge always agree.

const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || 5);

// Paystack Nigeria local-card rate: 1.5% + ₦100, capped at ₦2,000, with
// the flat ₦100 waived under ₦2,500. The platform bears Paystack's real
// deduction (bearer: "account"), so rounding differences never touch the
// seller's payout.
const estimatePaystackFee = (amountNaira) => {
  const percentFee = amountNaira * 0.015;
  const flatFee = amountNaira < 2500 ? 0 : 100;
  return Math.min(percentFee + flatFee, 2000);
};

const computeListingCheckout = (sellerPrice) => {
  const paystackFee = Math.round(estimatePaystackFee(sellerPrice));
  const commission = Math.round(sellerPrice * (PLATFORM_FEE_PERCENT / 100));
  const platformFee = paystackFee + commission;
  const totalCharge = sellerPrice + platformFee;
  return { sellerPrice, paystackFee, commission, platformFee, totalCharge };
};

const midpoint = (min, max) => Math.round((min + max) / 2);

const NIGERIA_PHONE_REGEX = /^(?:\+234|0)[789][01]\d{8}$/;
const isValidNigerianPhone = (value) =>
  typeof value === "string" && NIGERIA_PHONE_REGEX.test(value.trim());

module.exports = {
  PLATFORM_FEE_PERCENT,
  estimatePaystackFee,
  computeListingCheckout,
  midpoint,
  isValidNigerianPhone,
};
