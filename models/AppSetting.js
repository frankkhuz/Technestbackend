const mongoose = require("mongoose");

// Small key/value store for settings admins can change without a redeploy
// (e.g. "ai.enabled").
const AppSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, maxlength: 100 },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AppSetting", AppSettingSchema);
