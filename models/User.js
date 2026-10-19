const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    userType: {
      type: String,
      enum: ["user", "vendor", "admin"],
      default: "user",
    },
    isVerified: { type: Boolean, default: false },
    // Stamped into every login token; bumping it ends all existing sessions
    // (password reset, "log out everywhere", admin force sign-out)
    tokenVersion: { type: Number, default: 0 },
    verificationToken: String,
    verificationTokenExpires: Date,
    passwordResetToken: String,
    passwordResetExpires: Date,
    vendorVerified: { type: Boolean, default: false },
    // Shown publicly on listings — never put documents or private data here
    vendorProfile: {
      phone: String,
      businessRegNumber: String,
      shopAddress: String,
      businessName: String,
      // What the vendor does, used to route customer requests to them
      vendorTypes: {
        type: [{ type: String, enum: ["phone_dealer", "gadgets", "accessories", "repairs"] }],
        default: undefined,
      },
      brands: { type: [String], default: undefined },
      // Nigerian states they serve; empty = nationwide
      states: { type: [String], default: undefined },
      city: String,
      // ids from data/repairs.json, for repairers
      repairServices: { type: [String], default: undefined },
    },
    // Private: CAC certificate upload (Cloudinary public_id, authenticated)
    vendorDocuments: {
      cacCertificateId: { type: String, default: null },
    },

    // Phone verification (utils/whatsapp.js): automatic via the WhatsApp
    // Cloud API, or ticked by staff after chatting with the customer
    phone: { type: String, default: null }, // +234..., set once verified
    phoneVerified: { type: Boolean, default: false },
    phoneVerifiedAt: { type: Date, default: null },
    phoneVerifiedVia: { type: String, enum: ["whatsapp", "admin", null], default: null },
    phoneVerification: {
      phone: String, // the number being verified
      method: { type: String, enum: ["whatsapp", "manual"] },
      codeHash: String,
      expiresAt: Date,
      requestedAt: Date,
    },

    // Free identity check (utils/identity.js). identityVerified is the
    // public "verified seller" badge.
    identityVerified: { type: Boolean, default: false },
    identity: {
      status: {
        type: String,
        enum: ["none", "pending", "verified", "rejected"],
        default: "none",
      },
      fullName: String,
      idType: String,
      idDocumentId: String, // private Cloudinary public_id
      selfieId: String, // private Cloudinary public_id
      bankName: String,
      bankCode: String,
      accountLast4: String,
      accountName: String, // as the bank has it
      nameMatch: { type: String, enum: ["match", "partial", "mismatch", "unchecked"] },
      submittedAt: Date,
      reviewedAt: Date,
      reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      rejectionReason: String,
    },
    devices: [{ type: mongoose.Schema.Types.ObjectId, ref: "Device" }],
  },
  { timestamps: true }
);

UserSchema.index({ "phoneVerification.codeHash": 1 }, { sparse: true });
UserSchema.index({ phone: 1 }, { sparse: true });

UserSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 12);
});

UserSchema.methods.matchPassword = function (entered) {
  return bcrypt.compare(entered, this.password);
};

UserSchema.methods.generateVerificationToken = function () {
  const rawToken = crypto.randomBytes(32).toString("hex");
  this.verificationToken = crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");
  this.verificationTokenExpires = Date.now() + 24 * 60 * 60 * 1000;
  return rawToken;
};

// Same scheme as verification: only the hash is stored, the raw token goes
// in the emailed link
UserSchema.methods.generatePasswordResetToken = function () {
  const rawToken = crypto.randomBytes(32).toString("hex");
  this.passwordResetToken = crypto
    .createHash("sha256")
    .update(rawToken)
    .digest("hex");
  this.passwordResetExpires = Date.now() + 60 * 60 * 1000;
  return rawToken;
};

module.exports = mongoose.model("User", UserSchema);
