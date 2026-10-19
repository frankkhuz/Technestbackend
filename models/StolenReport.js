const mongoose = require("mongoose");

// A device reported stolen by its owner. Pending reports already block
// listings (better to hold a listing for a day than sell a stolen phone);
// an admin confirms against the police extract or rejects.
//
// Status flow: pending → confirmed / rejected, and pending/confirmed →
// recovered (owner or admin closes it once the device is back).
const HitSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    context: { type: String, enum: ["listing", "check"], required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const StolenReportSchema = new mongoose.Schema(
  {
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Keyed hash for matching (see utils/imei.js) — never returned to clients
    imeiHash: { type: String, required: true, select: false },
    imeiLast4: { type: String, required: true },
    imeiTac: { type: String, required: true },

    brand: { type: String, required: true, trim: true, maxlength: 50 },
    model: { type: String, required: true, trim: true, maxlength: 100 },
    incidentDate: { type: Date, default: null },
    description: { type: String, trim: true, maxlength: 1000, default: null },

    policeStation: { type: String, required: true, trim: true, maxlength: 150 },
    // Photo/PDF of the police extract, uploaded to our Cloudinary
    policeReportUrl: { type: String, required: true },

    status: {
      type: String,
      enum: ["pending", "confirmed", "rejected", "recovered"],
      default: "pending",
    },
    reviewNotes: { type: String, trim: true, maxlength: 500, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },

    // Each time the IMEI turns up in a listing attempt or a public check
    hits: { type: [HitSchema], default: [] },
    lastAlertAt: { type: Date, default: null },
  },
  { timestamps: true }
);

StolenReportSchema.index({ imeiHash: 1, status: 1 });
StolenReportSchema.index({ status: 1, createdAt: -1 });
StolenReportSchema.index({ reporter: 1, createdAt: -1 });

module.exports = mongoose.model("StolenReport", StolenReportSchema);
