const mongoose = require("mongoose");

// A seller's bank payout destination, mirrored to a Paystack subaccount so
// marketplace-listing sales split automatically: the buyer pays one charge,
// Paystack routes the seller's price to their bank and the platform fee to
// the main TechNest account.
const PayoutAccountSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    bankCode: { type: String, required: true },
    bankName: { type: String, required: true },
    accountNumber: { type: String, required: true, match: /^\d{10}$/ },
    accountName: { type: String, required: true },
    subaccountCode: { type: String, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PayoutAccount", PayoutAccountSchema);
