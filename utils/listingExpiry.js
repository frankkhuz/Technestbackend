// Keeps the marketplace honest: a listing must be confirmed "still
// available" every 30 days. At 14 days the seller gets a reminder; at 30 it
// expires and leaves the marketplace until they confirm. Run from
// POST /api/internal/tick; listings held for a buyer are left alone.
const Listing = require("../models/Listing");
const { notify } = require("./notify");

const REMIND_AFTER_DAYS = 14;
const EXPIRE_AFTER_DAYS = 30;
// An expired listing older than this goes back through review when renewed
const REACTIVATE_WITHIN_DAYS = 60;

const days = (n) => n * 864e5;
const freshConfirmation = () => ({ lastConfirmedAt: new Date(), reminderSentAt: null, expiredAt: null });

const runListingExpiry = async (now = new Date()) => {
  // Listings from before this existed start a fresh 30 days
  const backfilled = await Listing.updateMany(
    { status: "active", lastConfirmedAt: null },
    { $set: { lastConfirmedAt: now } }
  );

  const notHeld = { $or: [{ reservedUntil: null }, { reservedUntil: { $lte: now } }] };

  const toExpire = await Listing.find({
    status: "active",
    lastConfirmedAt: { $lte: new Date(now - days(EXPIRE_AFTER_DAYS)) },
    ...notHeld,
  }).select("owner deviceName").limit(500);
  if (toExpire.length) {
    await Listing.updateMany({ _id: { $in: toExpire.map((l) => l._id) } }, { status: "expired", expiredAt: now });
    await notify(
      toExpire.map((l) => ({
        recipient: l.owner,
        type: "listing_update",
        title: "Your listing has expired",
        message: `We hid your ${l.deviceName} because it wasn't confirmed available for ${EXPIRE_AFTER_DAYS} days. Still selling? Tap "Still available" on the listing to bring it back.`,
        listing: l._id,
      }))
    );
  }

  const toRemind = await Listing.find({
    status: "active",
    reminderSentAt: null,
    lastConfirmedAt: { $lte: new Date(now - days(REMIND_AFTER_DAYS)) },
  }).select("owner deviceName lastConfirmedAt").limit(500);
  if (toRemind.length) {
    await Listing.updateMany({ _id: { $in: toRemind.map((l) => l._id) } }, { reminderSentAt: now });
    await notify(
      toRemind.map((l) => ({
        recipient: l.owner,
        type: "listing_update",
        title: `Is your ${l.deviceName} still available?`,
        message: `Tap "Still available" on your listing within ${EXPIRE_AFTER_DAYS - REMIND_AFTER_DAYS} days to keep it on the marketplace. If it's sold, mark it sold.`,
        listing: l._id,
      }))
    );
  }

  return { listingsBackfilled: backfilled.modifiedCount, listingsReminded: toRemind.length, listingsExpired: toExpire.length };
};

module.exports = { REMIND_AFTER_DAYS, EXPIRE_AFTER_DAYS, REACTIVATE_WITHIN_DAYS, freshConfirmation, runListingExpiry };
