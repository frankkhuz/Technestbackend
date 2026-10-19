// Whether a marketplace listing can still be bought, and holding it for one
// buyer while TechNest arranges the deal. Reservations carry their own
// expiry and are checked on read, so nothing has to run on a schedule.
const Listing = require("../models/Listing");

const RESERVATION_HOURS = 48;

/**
 * @returns {string|null} why the listing can't be bought, or null if it can.
 * `forRequestId` lets the order that holds the reservation through.
 */
const listingUnavailableReason = (listing, forRequestId = null) => {
  if (!listing || listing.status !== "active") return "This listing is no longer available.";
  if (
    listing.reservedUntil &&
    listing.reservedUntil > new Date() &&
    String(listing.reservedFor) !== String(forRequestId)
  )
    return "Another buyer is finalising this one. Check back later or pick a similar device.";
  return null;
};

/** Holds a listing for an order request. Atomic, so two admins can't double-book it. */
const reserveListing = (listingId, requestId, hours = RESERVATION_HOURS) => {
  const now = new Date();
  return Listing.findOneAndUpdate(
    {
      _id: listingId,
      status: "active",
      $or: [{ reservedUntil: null }, { reservedUntil: { $lte: now } }, { reservedFor: requestId }],
    },
    { reservedUntil: new Date(now.getTime() + hours * 3600 * 1000), reservedFor: requestId },
    { returnDocument: "after" }
  );
};

/** Releases a hold, but only if this request still owns it. */
const releaseListing = (listingId, requestId) =>
  Listing.updateOne(
    { _id: listingId, reservedFor: requestId },
    { reservedUntil: null, reservedFor: null }
  );

module.exports = { RESERVATION_HOURS, listingUnavailableReason, reserveListing, releaseListing };
