// One-time: marks accounts created before email verification existed as
// verified, so they aren't locked out now that verification is enforced.
// Those accounts never got a verification token; anyone who signed up
// since did, and still has to confirm their email.
//
//   node scripts/verifyExistingUsers.js           show how many would change
//   node scripts/verifyExistingUsers.js --apply   make the change
//
// Uses MONGO_URI from .env — check it points at the database you mean.
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const User = require("../models/User");

const FILTER = {
  isVerified: { $ne: true },
  userType: { $ne: "admin" },
  verificationToken: { $exists: false },
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Database: ${mongoose.connection.host}/${mongoose.connection.name}`);
  const count = await User.countDocuments(FILTER);
  if (!process.argv.includes("--apply")) {
    console.log(`${count} existing account(s) would be marked verified. Run again with --apply to do it.`);
  } else {
    const result = await User.updateMany(FILTER, { $set: { isVerified: true } });
    console.log(`Marked ${result.modifiedCount} account(s) verified.`);
  }
  console.log(`Unverified accounts left: ${await User.countDocuments({ isVerified: { $ne: true } })}`);
  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
