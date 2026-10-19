// What a completed deal earned TechNest, and who still owes whom. Deals
// arranged on WhatsApp settle offline, so staff confirm the final price
// when they complete them; the defaults below are only a starting point.
//
//   - catalog cart order: TechNest sells — the whole price is revenue
//   - marketplace listing order: TechNest collects from the buyer, keeps
//     its commission and owes the seller the rest (payout)
//   - customer request: the vendor deals with the customer and owes
//     TechNest its commission
const { PLATFORM_FEE_PERCENT } = require("./pricing");

const defaultCommission = (price) => Math.round(price * (PLATFORM_FEE_PERCENT / 100));

/**
 * Validates the final price / commission staff send when completing a
 * deal. Missing values get the defaults.
 * @returns {{ error } | { finalPrice, commission }}
 */
const settleAmounts = ({ finalPrice, commission }, { defaultPrice, defaultCommissionFor = defaultCommission }) => {
  const price = finalPrice === undefined || finalPrice === null || finalPrice === "" ? defaultPrice : Number(finalPrice);
  if (!Number.isFinite(price) || price < 0) return { error: "finalPrice must be an amount in naira." };
  const fee = commission === undefined || commission === null || commission === "" ? defaultCommissionFor(price) : Number(commission);
  if (!Number.isFinite(fee) || fee < 0 || fee > price) return { error: "commission must be between 0 and the final price." };
  return { finalPrice: Math.round(price), commission: Math.round(fee) };
};

module.exports = { PLATFORM_FEE_PERCENT, defaultCommission, settleAmounts };
