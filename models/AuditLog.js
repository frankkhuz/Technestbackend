const mongoose = require("mongoose");

// One entry per change an admin made (middleware/audit.js records them
// automatically): who, what, when, on which record, with what details.
const AuditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    actorName: { type: String, required: true },
    method: { type: String, required: true },
    path: { type: String, required: true }, // as called, e.g. /api/admin/listings/6650…/approve
    action: { type: String, required: true }, // with ids replaced, e.g. PATCH /api/admin/listings/:id/approve
    targetId: { type: String, default: null }, // first id in the path
    details: { type: mongoose.Schema.Types.Mixed, default: null }, // request body, scrubbed
    status: { type: Number, required: true },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ actor: 1, createdAt: -1 });
AuditLogSchema.index({ targetId: 1, createdAt: -1 });
// Kept two years, so the free database doesn't fill up
AuditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2 * 365 * 24 * 3600, name: "expire_after_2_years" });

module.exports = mongoose.model("AuditLog", AuditLogSchema);
