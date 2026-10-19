const mongoose = require("mongoose");

// A message from TechNest to a group of users (e.g. "all vendors: please
// complete your profile"). Delivered in-app to everyone in the audience and
// optionally by email; email progress is recorded here as it goes out.
const AnnouncementSchema = new mongoose.Schema(
  {
    audience: {
      type: String,
      enum: ["all_vendors", "approved_vendors", "pending_vendors", "customers", "everyone"],
      required: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    message: { type: String, required: true, trim: true, maxlength: 2000 },
    sendEmail: { type: Boolean, default: false },
    recipients: { type: Number, default: 0 },
    emailsQueued: { type: Number, default: 0 },
    emailsSent: { type: Number, default: 0 },
    emailsFailed: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Announcement", AnnouncementSchema);
