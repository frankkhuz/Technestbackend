const mongoose = require("mongoose");

// One row per day per AI feature — how often AI ran and how many tokens it
// used, so admins can see what AI is costing and when it failed.
const AiUsageSchema = new mongoose.Schema(
  {
    day: { type: String, required: true }, // YYYY-MM-DD (UTC)
    feature: { type: String, required: true },
    calls: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
  },
  { timestamps: true }
);

AiUsageSchema.index({ day: 1, feature: 1 }, { unique: true });

module.exports = mongoose.model("AiUsage", AiUsageSchema);
