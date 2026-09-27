const express = require("express");
const mongoose = require("mongoose");
const Transaction = require("../models/Transaction");
const Listing = require("../models/Listing");
const Notification = require("../models/Notification");
const { protect } = require("../middleware/auth");
const { verifyCsrfToken } = require("../middleware/csrf");
const { sendSuccess, sendError } = require("../utils/response");
const { calculateValuation, pickCondition } = require("../utils/valuation");
const { midpoint } = require("../utils/pricing");
const router = express.Router();

router.use(protect);

const isParty = (txn, user) =>
  txn.buyer.toString() === user._id.toString() ||
  txn.seller.toString() === user._id.toString();

const notify = (recipient, title, message, txn) =>
  Notification.create({
    recipientType: "specific",
    recipient,
    type: "transaction_update",
    title,
    message,
    listing: txn.listing,
    transaction: txn._id,
  });

/**
 * @swagger
 * /api/transactions:
 *   get:
 *     summary: Swap / buy / sell deals the user is part of
 *     tags: [Transactions]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         description: Only deals where the user is the buyer or the seller (default both)
 *         schema: { type: string, enum: [buyer, seller] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, accepted, completed, cancelled] }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [buy, sell, swap] }
 *       - in: query
 *         name: listingId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transactions fetched
 */
router.get("/", async (req, res, next) => {
  try {
    const { role, status, type, listingId } = req.query;
    const me = req.user._id;
    const filter =
      role === "buyer"
        ? { buyer: me }
        : role === "seller"
        ? { seller: me }
        : { $or: [{ buyer: me }, { seller: me }] };
    if (["pending", "accepted", "completed", "cancelled"].includes(status))
      filter.status = status;
    if (["buy", "sell", "swap"].includes(type)) filter.type = type;
    if (listingId && mongoose.isValidObjectId(listingId)) filter.listing = listingId;

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(100);

    sendSuccess(res, 200, "Transactions fetched", {
      transactions: transactions.map((t) => t.toClient()),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/transactions/swap-quote:
 *   post:
 *     summary: Value a device against a listing without creating a swap request
 *     description: Same valuation the real swap uses — lets the UI show the price difference before submitting.
 *     tags: [Transactions]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [listingId, offeredDevice]
 *             properties:
 *               listingId: { type: string }
 *               offeredDevice: { $ref: '#/components/schemas/OfferedDevice' }
 *     responses:
 *       200:
 *         description: Quote computed
 */
router.post("/swap-quote", async (req, res, next) => {
  try {
    const { listingId, offeredDevice } = req.body;
    if (!mongoose.isValidObjectId(listingId))
      return sendError(res, 404, "Listing not found");
    const listing = await Listing.findById(listingId);
    if (!listing) return sendError(res, 404, "Listing not found");

    const quote = buildSwapQuote(listing, offeredDevice);
    if (quote.error) return sendError(res, 400, quote.error);
    sendSuccess(res, 200, "Swap quote computed", { quote: quote.details, breakdown: quote.breakdown });
  } catch (err) {
    next(err);
  }
});

const buildSwapQuote = (listing, offeredDevice) => {
  if (!offeredDevice || typeof offeredDevice !== "object")
    return { error: "Tell us about the device you're offering." };

  const valuation = calculateValuation(offeredDevice);
  if (!valuation)
    return { error: "We couldn't value that device — pick one from the list or enter a price." };

  const offeredValuation = midpoint(valuation.minVal, valuation.maxVal);
  const targetMid = midpoint(listing.estimatedMin, listing.estimatedMax);
  const priceDifference = targetMid - offeredValuation;

  return {
    breakdown: valuation.breakdown,
    details: {
      offeredDeviceId: valuation.deviceId,
      offeredDeviceName: valuation.deviceName,
      offeredStorage: valuation.deviceStorage || null,
      offeredCondition: pickCondition(offeredDevice),
      offeredValuation,
      offeredMin: valuation.minVal,
      offeredMax: valuation.maxVal,
      valuationSource: valuation.isCustom ? "custom" : "catalog",
      targetPriceMin: listing.estimatedMin,
      targetPriceMax: listing.estimatedMax,
      priceDifference,
      direction:
        priceDifference > 0 ? "pay_extra" : priceDifference < 0 ? "refund" : "even",
    },
  };
};

/**
 * @swagger
 * components:
 *   schemas:
 *     OfferedDevice:
 *       type: object
 *       description: Condition report for the device being offered in a swap (same fields as the /value form)
 *       properties:
 *         category: { type: string, enum: [phone, laptop] }
 *         subType: { type: string, example: iphone }
 *         deviceId: { type: string, example: iphone-15-pro-256 }
 *         customDeviceName: { type: string, description: "Only for deviceId other-*" }
 *         customDevicePrice: { type: number, description: "Only for deviceId other-*" }
 *         batteryHealth: { type: number, example: 88 }
 *         batteryChanged: { type: boolean }
 *         screenChanged: { type: boolean }
 *         cameraChanged: { type: boolean }
 *         faceIdStatus: { type: string, enum: [working, broken] }
 *         simType: { type: string, enum: [physical, esim-unlocked, locked] }
 *         keyboardChanged: { type: boolean }
 *         ramUpgraded: { type: boolean }
 *         storageUpgraded: { type: boolean }
 *         otherRepairs: { type: string }
 * /api/transactions:
 *   post:
 *     summary: Open a swap or buy request on a marketplace listing
 *     description: >
 *       For swaps, the offered device is valued server-side. If the listing is
 *       worth more (topUpAmount > 0) the buyer pays the difference via
 *       POST /api/checkout/initialize with swapTransactionId. Repeating a
 *       request while one is still open returns the existing one.
 *     tags: [Transactions]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, listingId]
 *             properties:
 *               type: { type: string, enum: [swap, buy] }
 *               listingId: { type: string }
 *               offeredDevice: { $ref: '#/components/schemas/OfferedDevice' }
 *               message: { type: string, maxLength: 500 }
 *     responses:
 *       201:
 *         description: Request created
 *       200:
 *         description: An open request already existed and was returned
 *       400:
 *         description: Invalid request (own listing, bad device, ...)
 *       409:
 *         description: Listing no longer available
 */
router.post("/", verifyCsrfToken, async (req, res, next) => {
  try {
    const { type, listingId, offeredDevice } = req.body;
    if (!["swap", "buy"].includes(type))
      return sendError(res, 400, "type must be 'swap' or 'buy'");
    if (!mongoose.isValidObjectId(listingId))
      return sendError(res, 404, "Listing not found");

    const listing = await Listing.findById(listingId).populate("owner", "name");
    if (!listing || !listing.owner) return sendError(res, 404, "Listing not found");
    if (listing.status !== "active")
      return sendError(res, 409, "This listing is no longer available.");
    if (listing.owner._id.toString() === req.user._id.toString())
      return sendError(res, 400, "You can't open a transaction on your own listing.");

    const existing = await Transaction.findOne({
      type,
      listing: listing._id,
      buyer: req.user._id,
      status: { $in: ["pending", "accepted"] },
    });
    if (existing)
      return sendSuccess(res, 200, "You already have an open request on this listing", {
        transaction: existing.toClient(),
      });

    let swapDetails = null;
    let topUpAmount = 0;
    if (type === "swap") {
      const quote = buildSwapQuote(listing, offeredDevice);
      if (quote.error) return sendError(res, 400, quote.error);
      swapDetails = quote.details;
      topUpAmount = Math.max(0, quote.details.priceDifference);
    }

    const message =
      typeof req.body.message === "string" ? req.body.message.slice(0, 500) : null;

    const txn = await Transaction.create({
      type,
      listing: listing._id,
      listingDeviceName: listing.deviceName,
      listingStorage: listing.storage || null,
      seller: listing.owner._id,
      sellerName: listing.owner.name || listing.userName,
      buyer: req.user._id,
      buyerName: req.user.name,
      buyerPhone: req.user.vendorProfile?.phone || null,
      agreedPrice: type === "buy" ? listing.estimatedMax : null,
      swapDetails,
      topUpAmount,
      message,
    });

    await Notification.create({
      recipientType: "specific",
      recipient: listing.owner._id,
      type: type === "swap" ? "swap_request" : "buy_request",
      title: type === "swap" ? "New swap offer" : "Someone wants to buy",
      message:
        type === "swap"
          ? `${req.user.name} offered their ${swapDetails.offeredDeviceName} for your ${listing.deviceName}`
          : `${req.user.name} wants to buy your ${listing.deviceName}`,
      listing: listing._id,
      transaction: txn._id,
    });

    sendSuccess(res, 201, type === "swap" ? "Swap request sent" : "Buy request sent", {
      transaction: txn.toClient(),
      // Tells the UI whether to send the buyer to checkout next
      requiresPayment: topUpAmount > 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/transactions/{id}:
 *   get:
 *     summary: One transaction (buyer or seller only)
 *     tags: [Transactions]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transaction fetched
 *       403:
 *         description: Not your transaction
 *       404:
 *         description: Not found
 */
router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Not found");
    const txn = await Transaction.findById(req.params.id);
    if (!txn) return sendError(res, 404, "Not found");
    if (!isParty(txn, req.user)) return sendError(res, 403, "Not your transaction");
    sendSuccess(res, 200, "Transaction fetched", { transaction: txn.toClient() });
  } catch (err) {
    next(err);
  }
});

/**
 * @swagger
 * /api/transactions/{id}:
 *   patch:
 *     summary: Move a transaction to its next status
 *     description: >
 *       pending → accepted (seller only) or cancelled (either side);
 *       accepted → completed or cancelled (either side). Completing marks the
 *       listing sold/swapped and cancels other open requests on it. A swap
 *       with an unpaid top-up can't be completed.
 *     tags: [Transactions]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [accepted, completed, cancelled] }
 *     responses:
 *       200:
 *         description: Status updated
 *       400:
 *         description: Invalid transition
 *       403:
 *         description: Not allowed
 */
router.patch("/:id", verifyCsrfToken, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return sendError(res, 404, "Not found");
    const nextStatus = req.body.status;

    const txn = await Transaction.findById(req.params.id);
    if (!txn) return sendError(res, 404, "Not found");
    if (!isParty(txn, req.user)) return sendError(res, 403, "Not your transaction");

    const isSeller = txn.seller.toString() === req.user._id.toString();

    // Only the seller decides whether to take a pending request; either side
    // can back out, and either side can confirm the handover once accepted.
    if (txn.status === "pending" && nextStatus === "accepted" && !isSeller)
      return sendError(res, 403, "Only the seller can respond to a pending request.");

    const allowed = Transaction.VALID_TRANSITIONS[txn.status] || [];
    if (!allowed.includes(nextStatus))
      return sendError(res, 400, `Can't move from ${txn.status} to ${nextStatus}.`);

    if (nextStatus === "completed" && txn.topUpAmount > 0 && !txn.topUpPaid)
      return sendError(
        res,
        400,
        "The buyer still needs to pay the swap difference before this can be completed."
      );

    let listing = null;
    if (nextStatus === "accepted" || nextStatus === "completed") {
      listing = await Listing.findById(txn.listing);
      if (!listing || listing.status !== "active")
        return sendError(res, 409, "This listing is no longer available.");
    }

    // Conditional update so two concurrent requests can't both transition
    const updated = await Transaction.findOneAndUpdate(
      { _id: txn._id, status: txn.status },
      {
        status: nextStatus,
        cancelledBy: nextStatus === "cancelled" ? req.user._id : null,
      },
      { returnDocument: "after" }
    );
    if (!updated) return sendError(res, 409, "This request was just updated — refresh and try again.");

    const other = isSeller ? txn.buyer : txn.seller;

    if (nextStatus === "accepted") {
      await notify(
        txn.buyer,
        "Request accepted",
        `${txn.sellerName} accepted your ${txn.type} request for ${txn.listingDeviceName}` +
          (txn.topUpAmount > 0 && !txn.topUpPaid
            ? ` — pay the ₦${txn.topUpAmount.toLocaleString()} difference to proceed.`
            : "."),
        txn
      );
    } else if (nextStatus === "completed") {
      listing.status = txn.type === "swap" ? "swapped" : "sold";
      await listing.save();

      // The listing is gone — close every other open request on it
      const others = await Transaction.find({
        listing: txn.listing,
        _id: { $ne: txn._id },
        status: { $in: ["pending", "accepted"] },
      });
      await Transaction.updateMany(
        { _id: { $in: others.map((o) => o._id) } },
        { status: "cancelled" }
      );
      await Notification.insertMany(
        others.map((o) => ({
          recipientType: "specific",
          recipient: o.buyer,
          type: "transaction_update",
          title: "Listing no longer available",
          message: `${o.listingDeviceName} has been ${listing.status}, so your request was closed.`,
          listing: o.listing,
          transaction: o._id,
        }))
      );

      await notify(
        other,
        "Deal completed",
        `Your ${txn.type} of ${txn.listingDeviceName} is marked complete.`,
        txn
      );
    } else if (nextStatus === "cancelled") {
      await notify(
        other,
        isSeller && txn.status === "pending" ? "Request declined" : "Deal cancelled",
        `${req.user.name} cancelled the ${txn.type} for ${txn.listingDeviceName}.` +
          (txn.topUpPaid ? " Your top-up payment will be refunded." : ""),
        txn
      );
    }

    sendSuccess(res, 200, "Transaction updated", {
      status: updated.status,
      transaction: updated.toClient(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
