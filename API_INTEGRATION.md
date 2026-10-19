# TechNest backend — frontend integration guide

The backend now handles buy, sell, swap, buy again, device valuation, the
gadget recommender, the site chat and the repair helper. This guide lists
which endpoints to call and what to change in the frontend repo (`technest11`).

**AI is optional everywhere.** Every feature works without AI, using free
built-in logic. When AI is connected it improves the results. If AI isn't
set up, runs out of credit, is switched off by an admin, or fails, the same
endpoint quietly returns the free version, so the UI never breaks.

Full request and response schemas, with a "Try it out" button, are in
**Swagger at `<backend>/api/docs`**.

---

## 0. Conventions

- **Calling the backend.** Keep calling `/api/...` from the browser.
  `next.config.ts` forwards those calls to `BACKEND_URL`, but only when no
  local `app/api/...` route matches. See step 1.
- **Auth.** Log in with `POST /api/auth/login`. The session is stored in
  httpOnly cookies, so there's nothing to keep in `localStorage`.
- **CSRF.** Every `POST` / `PATCH` / `DELETE` made while logged in must send
  `X-CSRF-Token` (the value of the `csrfToken` cookie). `apiFetch` in
  `app/lib/api.ts` already does this, so **use `apiFetch`, not bare `fetch`,
  for mutations**. Without it you get `403 Invalid CSRF token`.
- **Response envelope.** Success returns `{ success: true, message, data }`
  and errors return `{ success: false, message }`, so read `json.data.x` and
  `json.message`. (The frontend's old local routes returned `{ x }` and
  `{ error }`.) Exception: `/api/listings` errors are still
  `{ success: false, error }`.
- **Money.** Amounts are whole naira. The backend always recomputes prices,
  so any price the client sends is ignored.
- **AI-assisted endpoints** return `data.source`:
  - `"ai"` means AI answered.
  - `"rules"` means the free version answered. `data.aiReason` then says why:
    `not_configured`, `disabled`, `paused`, `out_of_credit`, `daily_limit`,
    `rate_limited`, `declined`, `busy` or `error`.

  Both answers have the same shape, so render them the same way. Optionally
  show a small "AI" badge when `source` is `"ai"`. Never show an error just
  because AI wasn't used.
- **`GET /api/ai/status`** returns `{ enabled, reason }`. Use it only to hide
  AI-only extras, such as the "Fill in from photos" button.

## 1. Delete these local Next.js API routes

These folders currently override the backend. On Vercel they return empty
data or 500s because `MONGODB_URI` isn't set there. Delete them; the rewrite
then sends the same paths to the backend:

| Delete | Backend replacement |
|---|---|
| `app/api/transactions/` | `/api/transactions` (same paths) |
| `app/api/checkout/` | `/api/checkout/initialize`, `/api/checkout/verify` (same paths) |
| `app/api/payout-account/` | `/api/payout-account`, `/api/payout-account/banks` (same paths) |
| `app/api/listing-checkout-preview/` | **moved:** `/api/checkout/listing-preview` |
| `app/api/gadget-recommend/` | `/api/gadget-recommend` (same paths) |
| `app/api/chat/` | `/api/chat` (same path; section 11) |
| `app/api/repair-triage/` | `/api/repair-triage` (same path; section 12) |

After this, `app/lib/mongo.ts`, `app/lib/currentUser.ts` and the `mongodb`
dependency are only used by `listing-freshness`, `repair-vendors` and
`vendor-*`. Those still run on the frontend and weren't part of this work.
The frontend no longer needs `ANTHROPIC_API_KEY` or `@anthropic-ai/sdk`.

---

## 2. Buy — catalog

| | Endpoint | Returns |
|---|---|---|
| GET | `/api/products?type=phone\|gadget&category=&brand=&q=&sort=price-asc\|price-desc&condition=uk-used\|brand-new` | `data.products` |
| GET | `/api/products/:slug` (e.g. `iphone-17-pro-max`) | `data.product` |
| GET | `/api/products/search?q=iphone under 600k 256gb` | `data.products`, `data.filters`, `data.summary`, `data.relaxed`, `data.source` |

**Search box.** Use `/api/products/search` for the /buy search box.

- It understands budgets ("under 600k"), brands, categories, storage and
  "brand new" / "used" without AI. With AI it understands any phrasing.
- Show `data.filters` as removable chips, so the shopper sees how their search
  was read.
- `relaxed: true` means nothing matched every word, so the closest options
  are shown.
- Call it when the shopper submits, not on every keystroke.

Each product has the same shape as the old `BuyPhone` / `BuyGadget`
(`id, name, brand, priceUkUsed, priceBrandNew, badge, image, storage, ram,
category, color` for phones; `gadgetCategory, spec, tags` for gadgets), plus
`type` and `inStock`. **Ids are the same as the old static ids**, so carts
already saved in `localStorage` keep working.

**Change:** in `app/buy/page.tsx`, `app/buy/[id]/page.tsx` and
`app/context/CartContext.tsx`, replace the `phones` / `gadgets` imports from
`app/data/gadget.ts` with data fetched from `/api/products`. Grey out items
where `inStock` is false. Keep `brands` and `gadgetCategories` as static UI
lists.

UK-used prices now follow the dealer price lists. For example, the iPhone
17 Pro Max is ₦1.65M (was ₦2.1M) and the Pixel 9 is ₦530k.

## 3. Checkout (cart, listing purchase, swap top-up)

| | Endpoint | Body / returns |
|---|---|---|
| POST | `/api/checkout/initialize` | Same body as before: `{ buyerName, buyerEmail, buyerPhone, deliveryAddress }` plus **exactly one** of `items` (cart lines), `listingId`, or `swapTransactionId`. Returns `data.authorizationUrl` (redirect here), `data.reference`, `data.order` |
| GET | `/api/checkout/verify?reference=` | `data.order` with `status`: `pending` / `paid` / `failed` |
| GET | `/api/checkout/listing-preview?listingId=` | `data.preview` = `{ sellerPrice, platformFee, totalCharge }` |

- **Checkout now requires login**, including cart checkout. Send guests to
  `/auth/login?from=/checkout`.
- Errors to handle: `409` (out of stock, listing sold, or seller has no payout
  account), `503` (Paystack not configured yet).

**Change:**

- `app/checkout/page.tsx`: use `apiFetch` for initialize, read
  `json.data.authorizationUrl`, switch the preview call to
  `/api/checkout/listing-preview`, and read `json.data.transaction` from
  `GET /api/transactions/:id`.
- `app/checkout/callback/page.tsx`: read `json.data.order`. If the status is
  still `pending`, retry after a few seconds. The Paystack webhook may settle
  the order first.

## 4. Buy again

| | Endpoint | Returns |
|---|---|---|
| GET | `/api/orders?status=paid&kind=cart` | `data.orders` (the user's order history) |
| GET | `/api/orders/:id` | `data.order` |
| GET | `/api/orders/buy-again` | `data.items`: products the user has paid for, each with `currentPrice`, `available`, `lastBoughtAt`, `timesBought` and the full `product` |
| GET | `/api/orders/:id/buy-again` | `data.items` (cart lines at today's prices), `data.unavailable[]`, `data.priceChanges[]`, `data.delivery` (to prefill the form) |

**Suggested UI:**

- **"Buy again" shelf on `app/user/page.tsx`:** fed by
  `GET /api/orders/buy-again`. Its Add button calls `addToCart`.
- **"Order again" button on each past order:** calls
  `/api/orders/:id/buy-again`, loads `items` into the cart with
  `setCartToSingleItem` / `addToCart`, prefills checkout with `delivery`, and
  shows any `priceChanges` or `unavailable` items as a notice.

## 5. Sell

| | Endpoint | Notes |
|---|---|---|
| POST | `/api/listings` | Optional **`description`** field (max 1000 characters). **Phones now need `imei`**, and `imeiVerified` from the client is ignored (section 13). New listings wait for admin approval (`pending_review`) |
| POST | `/api/listings/assist` | `{ images?, fields? }` returns `data.suggestion` = `{ description, deviceId?, deviceName?, storage?, visibleIssues[], confidence? }` and `data.source`. Nothing is saved |
| GET | `/api/listings/mine` | **Fixed** (it returned 500 before). Includes `bids[]`, each with `_id` |
| POST | `/api/listings/:id/bids/:bidId/accept` | Seller accepts a vendor's offer and gets back `data.transaction`, an accepted deal of type `sell` |
| PATCH | `/api/transactions/:id` `{ status: "completed" }` | Either side confirms the handover, and the listing becomes `sold` |
| GET/POST | `/api/payout-account`, GET `/api/payout-account/banks` | Seller's bank account (same body as before). Needed before buyers can pay for their listing online |
| POST | `/api/vendor/bid`, GET/POST/PATCH `/api/vendor/inventory` | **Fixed** (they returned 404 before) |

**Change `app/value/page.tsx`:**

- Add a **Description** textarea to the form.
- Add a **"Write it for me"** button that calls `/api/listings/assist` with the
  form fields, and with the uploaded Cloudinary image URLs if there are any.
  It always returns a description: an AI one when AI is available, otherwise
  a clean one built from the form.
- When AI is on and photos are sent, it also suggests the device and lists
  `visibleIssues` (e.g. "small crack on back glass"). Show those as notes for
  the seller to confirm, and never tick condition boxes silently.
- Only show the "from photos" wording when `/api/ai/status` says AI is
  enabled.

**Change `app/user/page.tsx`:** add an **Accept** button to each vendor offer
that calls the accept endpoint.

## 6. Swap

**How it works.** The server values the device the buyer offers, then
compares it with the listing:

> **priceDifference = middle of the listing's price range − value of the offered device**

- **Above 0:** the buyer pays the difference (the "top-up") through checkout.
- **Below 0:** the seller owes the buyer the difference, settled between them
  outside the app.

| | Endpoint | Body / returns |
|---|---|---|
| POST | `/api/transactions/swap-quote` | `{ listingId, offeredDevice }` returns `data.quote` (a live preview; nothing is saved) |
| POST | `/api/transactions` | `{ type: "swap", listingId, offeredDevice, message? }` returns `data.transaction` and `data.requiresPayment` |
| POST | `/api/transactions` | `{ type: "buy", listingId }`: a request to buy a listing (the marketplace "buy request") |
| GET | `/api/transactions?role=buyer\|seller&status=&type=` | `data.transactions` |
| PATCH | `/api/transactions/:id` | `{ status: "accepted" \| "completed" \| "cancelled" }` |

`offeredDevice` is the `/value` form's condition report: `category, subType,
deviceId, batteryHealth, batteryChanged, screenChanged, cameraChanged,
faceIdStatus, simType, keyboardChanged, ramUpgraded, storageUpgraded,
otherRepairs`. For `other-*` devices, also send `customDeviceName` and
`customDevicePrice`.

**Rules the server enforces:**

- Only the seller can accept a swap request.
- A swap can't be completed until any top-up is paid.
- Completing a deal marks the listing `swapped` / `sold` and closes the other
  open requests on it.

**Change `app/component/transactions/SwapModal.tsx`:**

1. Load the device dropdown from `GET /api/valuation/devices` (section 7), not
   `iphoneDevices`. Android and laptop owners can then swap too.
2. Show the price difference from `swap-quote`.
3. Send `offeredDevice: form` without `mediaFiles`. Drop `swapDetails`,
   `sellerId`, `sellerName` and `listingDeviceName`; the server reads these
   from the listing.
4. If `data.requiresPayment` is true, go to
   `/checkout?swapTransactionId=<id>`.
5. **Fix the sign bug.** The modal currently computes
   `diff = yours − theirs` and shows a positive number as "You pay extra",
   which is backwards. Using `quote.priceDifference` and `quote.direction`
   fixes it.

In `app/marketplace/page.tsx`, switch `handleBuyRequest` to `apiFetch` and
send only `{ type: "buy", listingId }`.

## 7. Valuation (used by /value and the swap window)

| | Endpoint | Returns |
|---|---|---|
| GET | `/api/valuation/devices` | Every device table: `data.devices.phone.iphone`, `.phone.android`, `.laptop.macbook` / `windows` / `linux` / `gaming` |
| GET | `/api/valuation/devices?category=phone&subType=android` | One table |
| POST | `/api/valuation/estimate` (body = condition report) | `data.valuation` = `{ basePrice, breakdown[], deductionPercent, min, max, value }` |

Base prices come from the dealer price lists (the `sources` field names each
list). There are 144 priced phones, including Pixel 7–10, Samsung S8–S26,
Notes, Flips and Folds.

**Change `app/value/page.tsx`:**

- Load devices from this endpoint instead of `iphoneDevices`,
  `androidDevices` and `laptopDevices`.
- Show `estimate` for the price breakdown instead of calling
  `calculateValuation` in the browser. Keep sending the result as
  `estimatedMin` / `estimatedMax` when creating the listing.
- **Remove the `fetch("https://api.anthropic.com/v1/messages")` IMEI check.**
  It has no API key, so it always fails. It also asks an AI model whether an
  IMEI is stolen, which a model can't know, so it would flag honest sellers
  at random. Keep the Luhn `validateIMEI` check for instant feedback while
  typing; the backend now does the real checks (section 13).

## 8. AI gadget recommender

| | Endpoint | Body / returns |
|---|---|---|
| POST | `/api/gadget-recommend` | `{ messages, conversationId? }` returns `data.reply`, `data.rawReply`, `data.conversationId` |
| GET | `/api/gadget-recommend/history` | `data.conversations` (signed-in users) |
| GET | `/api/gadget-recommend/:id` | `data.messages` |
| DELETE | `/api/gadget-recommend/:id` | Deletes a conversation |

- **Works without AI.** Without AI (`source: "rules"`) it reads budget,
  category and brand from the conversation and shows the best matching
  products in stock. If the user hasn't said enough, it asks one question.
- **Guests and signed-in users.** Guests can use it, but only signed-in
  users' chats are saved.
- **AI limit per visitor.** Each IP gets 20 AI replies per 15 minutes, then
  the free version answers. The user never sees an error for this.
- **Catalog.** It now recommends **phones as well as gadgets**, using live
  catalog prices.
- **`data.reply.catalogMatches[]`.** Each match includes the full `product`,
  so no second lookup is needed. Ids that aren't in the catalog are removed.

**Change `app/recommend/page.tsx`:**

1. Use `apiFetch` for the POST.
2. Read `json.data.reply`.
3. **Send `data.rawReply` as the assistant message content** on the next turn,
   not `JSON.stringify(reply)`. `reply` now includes full product data, and
   sending it back would bloat every request.
4. Render `source: "rules"` replies exactly like AI ones. There's no special
   error handling for AI.

## 9. Notifications

New `type` values to handle in the notification list: `swap_request`,
`buy_request`, `transaction_update`, `order_paid`, `listing_sold`, `offer_accepted`,
`stolen_device_alert` (your reported device was checked or someone tried to
list it), `stolen_report_update` (an admin confirmed/rejected your report).
Notifications can also carry `transaction` and `order` ids, so you can link to
them.

## 10. Admin panel additions

| | Endpoint |
|---|---|
| GET | `/api/admin/orders?status=&kind=&fulfillmentStatus=` |
| PATCH | `/api/admin/orders/:id/fulfillment` `{ fulfillmentStatus: processing \| shipped \| delivered }` (notifies the buyer) |
| GET | `/api/admin/transactions?type=&status=` |
| GET | `/api/admin/products` (includes hidden and out-of-stock products) |
| POST / PATCH / DELETE | `/api/products[/:slug]` (manage the catalog: prices, `inStock`, details) |

### Listing review

| | Endpoint | Notes |
|---|---|---|
| GET | `/api/admin/listings/pending` | Each listing now has **`checks[]`**: free automatic red flags such as a price under half the market price, phone numbers or bank details in the text, no photos, a duplicate listing, or a brand-new account. Each check is `{ code, severity: high \| medium \| info, message }` |
| GET | `/api/admin/listings/:id/review` | `checks`, the last `aiReview`, `marketPrice` and `ai` status |
| POST | `/api/admin/listings/:id/review` | **"AI review"** button. With AI it adds a summary, flags and a photo check, saved on the listing. Without AI it returns the checks and `aiReason`. The admin still decides |

Show the checks as coloured chips on each pending listing (high = red,
medium = amber, info = grey). New IMEI check codes: `imei_missing`,
`imei_model_mismatch` (high — the IMEI belongs to a different model),
`imei_model_unknown`, `no_imei_photo`. Show `imeiPhoto` next to the photos.

### Stolen reports and IMEI model codes

| | Endpoint | Notes |
|---|---|---|
| GET | `/api/admin/imei/stolen-reports?status=pending` | Reports with the reporter, the police report file and `hits[]` (each time the IMEI was checked or someone tried to list it, with who) |
| PATCH | `/api/admin/imei/stolen-reports/:id` `{ status: confirmed \| rejected \| recovered, reviewNotes? }` | **Confirm** after checking the police extract. Confirming takes down open listings with that IMEI. The reporter is notified either way |
| GET | `/api/admin/imei/tac?q=` | Search the model-code table by code, brand or model |
| POST | `/api/admin/imei/tac` `{ tac, brand, model, deviceType? }` | Add or correct one code |
| POST | `/api/admin/imei/tac/import` `{ csv }` | Paste up to ~250 lines of `tac,brand,model`. Bigger files: `npm run tac:import -- file.csv` |
| GET | `/api/admin/imei/tac/unknown` | Codes seen on listings that aren't in the table yet — fill these in |
| GET | `/api/admin/imei/tac/mismatches` | Codes where the seller's device name didn't match. Many on one code can mean the table entry is wrong |

Approving a listing whose code is unknown saves the code as that listing's
device name, so the table grows by itself.

### Prices (valuation base prices and the catalog's UK-used prices)

| | Endpoint | Notes |
|---|---|---|
| GET | `/api/admin/prices/devices?category=&subType=&q=` | Every device with its dealer `quotes[]`, `baseMax` and `priceSource` (`market` / `manual` / `legacy`) |
| POST | `/api/admin/prices/devices` | Add a device by hand: `{ category, subType, name, storage, baseMax }` |
| PATCH | `/api/admin/prices/devices/:deviceId` | Edit by hand: `baseMax` pins a manual price, `useQuotes: true` goes back to the dealer-quote price, `isActive: false` hides the device |
| DELETE | `/api/admin/prices/devices/:deviceId/quotes/:quoteId` | Remove a bad quote |
| POST | `/api/admin/prices/parse` | `{ text }`: paste a WhatsApp price list and get `rows[]` back to review. `source` says whether AI or the free reader read it (`method: "rules"` forces the free reader) |
| POST | `/api/admin/prices/preview` | `{ sourceName, rows }` shows the device and catalog prices before → after. **Nothing is saved** |
| POST | `/api/admin/prices/apply` | Same body. Saves the quotes and updates valuation and catalog prices immediately. It only re-prices catalog products that already exist and never creates them — fill an empty catalog with `npm run seed:products` |
| PATCH | `/api/admin/prices/settings` | `{ strategy: avg \| min \| max, catalogMarkup: 0–100 }` |

**Suggested admin "Update prices" page:**

1. The admin pastes a list, types a source name, and clicks **Read list**
   (`parse`).
2. A table appears, one row per line. Rows with `deviceId: null` get a
   dropdown built from `candidates` (or from the full device list), and a
   checkbox untick removes a row.
3. The admin clicks **Preview** (`preview`) to see the before → after table.
4. The admin clicks **Apply** (`apply`).

Entering prices by hand works without any list: edit `baseMax` on the devices
table.

### AI switch

| | Endpoint | Notes |
|---|---|---|
| GET | `/api/admin/ai` | `status`, `dailyLimit`, and 30 days of `usage` per feature with `estimatedCostUsd` |
| PATCH | `/api/admin/ai` | `{ enabled: true \| false }` turns AI off or on for the whole app, with no redeploy. Turning it on also clears an automatic pause (e.g. after topping up credit) |

## 11. Site chat (the chat bubble)

| | Endpoint | Body / returns |
|---|---|---|
| POST | `/api/chat` | `{ messages }` returns `data.reply` (text), `data.links[]` (`{ label, href }` in-app pages), `data.whatsapp`, `data.source` |

- **Without AI**, it answers from a built-in FAQ covering selling, swapping,
  buying, payments, delivery, IMEI, battery, vendors, repairs, accounts and
  safety.
- **For signed-in users** it answers "where is my order?", "my swaps" and
  "my listings" from their real data, with or without AI.
- **Anything it can't answer** points to WhatsApp.

**Change `app/component/layout/ChatWidget.tsx`:**

1. Use `apiFetch`.
2. Read `json.data.reply`.
3. Render `links` as buttons.
4. Show `whatsapp` as a "Chat with a person" option.

## 12. Repair helper (Fix My Device)

| | Endpoint | Body / returns |
|---|---|---|
| POST | `/api/repair-triage` | `{ messages }` returns `data.reply` = `{ type: question \| diagnosis, message, quickFixSteps[], repairMatches[{ id, reason, service }], productMatches[{ id, reason, product }], suggestRepairerContact }`, plus `data.rawReply`, `data.whatsapp`, `data.source` |
| GET | `/api/repair-triage/services` | The estimated repair price list, for browsing without the chat |

- **Without AI**, it recognises the device and the problem from what the user
  types (won't charge, cracked screen, got wet, won't turn on, battery,
  camera, sound, buttons, overheating, keyboard, HDMI). It gives safe quick
  checks (including the right force-restart steps), the matching repair price
  ranges, relevant accessories, and the WhatsApp booking link.
- **With AI**, it asks follow-up questions first.

**Change `app/component/fix/RepairChatPanel.tsx`:**

1. Use `apiFetch`.
2. Read `json.data.reply`.
3. Send `data.rawReply` back as the assistant turn.
4. `service` and `product` are included in the matches, so there's no need to
   look them up in `app/data/repairs.ts`.

## 13. IMEI checks (free, no paid service)

The backend checks every phone IMEI itself: valid check digit, which model
the number belongs to (its first 8 digits, the "TAC", looked up in our own
table), whether it's already listed, and whether it's been reported stolen.
The full IMEI is never stored or returned, only its last 4 digits.

**Listing a phone** (`POST /api/listings`, and `PATCH` when the IMEI changes):

- Send **`imei`** (required for `deviceCategory: "phone"`, optional for
  others). 15 digits; spaces/dashes are fine, and 14-digit or 16-digit
  (IMEISV) numbers are accepted too.
- Optionally send **`imeiPhoto`**: the Cloudinary URL of a photo of the
  `*#06#` screen (upload it the same way as listing photos). Ask for it —
  admins see a flag when it's missing.
- **Stop sending `imeiVerified`.** The server sets it.
- Errors come back as `{ success: false, error }` with:
  - `400` — not a valid IMEI, or a phone with no IMEI
  - `409` — reported stolen, or already listed (by this seller or someone else)
- The listing comes back with `imeiVerified`, `imeiLast4`, `imeiTac`,
  `imeiPhoto` and `imeiCheck: { modelMatch: match | mismatch | unknown, tacBrand, tacModel }`.
  Show "IMEI checked ✓ ending 1234" on the listing.
- Editing an older phone listing that has no IMEI now requires adding one.

**Public IMEI check** (a "Check an IMEI" box for buyers — free, no login):

| | Endpoint | Body / returns |
|---|---|---|
| POST | `/api/imei/check` | `{ imei, deviceName? }` returns `data: { valid, imeiLast4, device: { brand, model } \| null, modelMatch?, reportedStolen, stolenReport: { status, policeStation, reportedAt } \| null }`. 20 checks per 15 minutes per visitor |

Show a big red warning when `reportedStolen` is true ("Don't buy this
device"). When `deviceName` is sent and `modelMatch` is `mismatch`, warn that
the IMEI belongs to `device.brand device.model`.

**Reporting a stolen device** (logged in):

| | Endpoint | Body / returns |
|---|---|---|
| POST | `/api/imei/stolen-reports` | `{ imei, brand, model, policeStation, policeReportUrl, incidentDate?, description? }`. `policeReportUrl` is a Cloudinary upload of the police extract. Returns `data.report`. `409` if that IMEI is already reported |
| GET | `/api/imei/stolen-reports` | The user's own reports, each with `status` (pending, confirmed, rejected, recovered) and `timesChecked` |
| PATCH | `/api/imei/stolen-reports/:id/recovered` | Owner closes the report once the device is back |

A pending report already blocks the IMEI from being listed; an admin then
confirms or rejects it.

## 14. Email verification, password reset and email notifications

New accounts get a "Confirm your email" link. Until they click it, these
return **`403` with `code: "email_not_verified"`**: creating a listing, a
buy/swap request, checkout, a vendor bid, the vendor application and a
stolen-device report. The body has both `message` and `error`. When you see
that code, show the message with a **"Resend link"** button.

This check only switches on once email is configured on the backend, so
nothing is blocked before then. Accounts created before this change start
unverified too — they'll need "Resend link" once.

| | Endpoint | Notes |
|---|---|---|
| — | `<CLIENT_URL>/api/auth/verify-email/<token>` | The emailed link. It goes through the `/api` rewrite to the backend, which redirects to **`/login?verified=success`** or **`/login?verified=invalid`**. Show a toast on the login page for each |
| POST | `/api/auth/resend-verification` | Logged in. Sends a new link (max 5 per hour). Answers "already verified" if it is |
| POST | `/api/auth/forgot-password` `{ email }` | Always answers the same, whether or not the account exists |
| POST | `/api/auth/reset-password` `{ token, password }` | **New page needed: `/reset-password`.** The emailed link is `/reset-password?token=…`; the page asks for a new password (8+ characters) and sends the token from the URL. Then send the user to log in |

`GET /api/me` and the login response already include `isVerified` — show a
small "Confirm your email" banner while it's false.

**Phone numbers.** Listings (`userPhone`) and the vendor application
(`phone`) must be Nigerian mobile numbers. Any common format is accepted
(`0803 123 4567`, `+234 803…`, `234803…`) and saved as `+2348031234567`.
Invalid numbers get `400`.

**Notifications are now emailed too**, and each person has their own copy
(the old shared broadcasts made one vendor's "mark read" mark it read for
everyone). Vendors get new-listing alerts in-app only, to save the free email
quota. New `type` values: `listing_update` (your listing was approved or
rejected, with the reason) and `account_update` (vendor application approved
or rejected). Admins can send `{ reason }` when rejecting a vendor.

## 15. Checkout: WhatsApp now, online payment "coming soon"

Show two buttons at checkout (cart and marketplace listings):

- **Chat with us on WhatsApp** — `POST /api/order-requests` with
  `{ items: [{ itemId, quantity, condition }] }` (cart) **or** `{ listingId }`,
  plus `buyerName`, `buyerPhone`, optional `buyerEmail`, `state`, `note`.
  Works for guests. Returns `data.request` (with a reference like
  `TN-7K3QXP`) and **`data.whatsappUrl` — open it**; the message already
  lists the items, total and reference. Prices come from the server (flash
  sale prices included).
- **Pay on platform** — `GET /api/order-requests/options` returns
  `online: { enabled: false, label: "Coming soon" }`. Show the button
  disabled with that label. It turns on when the backend sets
  `ONLINE_PAYMENTS=on`.

Logged-in buyers see their orders at `GET /api/order-requests/mine` (each
with `whatsappUrl` to reopen the chat). Status: `new` → `in_progress` →
`completed` / `cancelled`; buyers are notified of each change.

**Admin page "WhatsApp orders":** `GET /api/admin/order-requests?status=&q=`
(with counts) and `PATCH /api/admin/order-requests/:id { status, adminNotes }`.
Moving a listing order to `in_progress` **holds the listing for 48 hours**
(send `in_progress` again to extend) and tells the seller; `completed` marks
it sold and closes other requests on it; `cancelled` releases the hold.

**Held listings:** every listing now has `isReserved` and `isAvailable`.
Show a "Reserved" badge, or use `GET /api/listings?available=true` to hide
them. Buy/swap requests, checkout and vendor offers on a held listing get
`409` with a friendly message. Holds expire by themselves.

## 16. Identity check ("verified seller") — free, no NIN fee

1. Upload the ID photo and a selfie **privately**:
   `POST /api/uploads/signature { purpose: "private" }` returns
   `type: "authenticated"` and a private folder. Include `type=authenticated`
   in the Cloudinary upload form and keep the returned **`public_id`** (the
   URL won't open publicly — that's the point).
2. `POST /api/identity { fullName, idType, idDocumentId, selfieId, bankCode, bankName, accountNumber }`
   (`idType`: `nin_slip`, `drivers_licence`, `international_passport`,
   `voters_card`; banks from `GET /api/payout-account/banks`). The backend
   checks the bank account exists and compares its name with the ID name.
3. `GET /api/identity` shows `status` (none, pending, verified, rejected,
   with `rejectionReason`). Rejected users can submit again.

Approved users get `identityVerified: true` — it's on `GET /api/me` and on
each listing's `owner`. Show a **"Verified seller"** badge.

**Admin page "Identity checks":** `GET /api/admin/identity?status=pending`
gives signed links to the ID photo and selfie, the bank's account name and
`nameMatch` (match / partial / mismatch / unchecked). `PATCH
/api/admin/identity/:userId { status: verified | rejected, reason }`.

## 17. Vendor onboarding: types, coverage, CAC

`PATCH /api/vendor/verify` now also takes `businessName`, `vendorTypes`
(`phone_dealer`, `gadgets`, `accessories`, `repairs`), `brands`, `states`
(Nigerian states served — empty means nationwide), `city`, `repairServices`
(ids from `GET /api/repair-triage/services`) and `cacCertificateId` (a
private upload's `public_id`). `businessRegNumber` must look like `RC1234567`
or `BN1234567`. These decide which customer requests reach the vendor, so
make them checkboxes on the vendor form. Old vendors without types count as
phone dealers.

The admin pending-vendors list now includes `cacCertificateUrl` (signed
link) and the vendor's identity status. Vendors can also bulk-upload stock
(section 19).

`GET /api/vendors/directory?type=repairs&state=Lagos` lists approved vendors
(name, types, states, brands — no phone numbers; TechNest arranges deals).

## 18. Customer requests and vendor offers (smart vendor matching)

Instead of TechNest staff calling round, a customer posts a request and it
goes to matching vendors only.

**Customer:**

- `POST /api/requests` with `type` (buy, sell, swap, repair, accessory),
  `category` (phone, laptop, tablet, wearable, gaming, audio, camera,
  accessory, other), `deviceName`, `state`, and as relevant `storage`,
  `condition`, `wantedDevice` (swap, required), `issue` (repair, required),
  `repairServiceId`, `budgetMin`/`budgetMax`, `images`, `city`,
  `snapchatStatus`, `imei` (sell/swap — checked against stolen reports),
  `autoSelect`, `hours` (how long vendors have, default 72).
  Returns `matchedVendors` (how many vendors got it). The customer gets an
  automatic confirmation in-app and by email.
- `GET /api/requests` and `GET /api/requests/:id` — offers come back
  **best first** with `recommended: true` on the top one, plus
  `vendorVerified` and `vendorCompletedDeals`. Contacts are never shown.
- `POST /api/requests/:id/offers/:offerId/accept` — returns `whatsappUrl`
  to chat with TechNest, who arrange the deal.
- `POST /api/requests/:id/cancel`.
- With `autoSelect: true`, the best offer is accepted automatically when the
  request closes. **The rule:** best price wins (lowest, or highest for
  sell requests); ties go to the vendor with more completed deals, then the
  earlier offer.

**Vendor** (approved only):

- `GET /api/requests/for-vendor?status=open` — requests matched to them.
- `POST /api/requests/:id/offers { price, message, eta, warrantyDays }`
  (send again to update), `DELETE /api/requests/:id/offers` to withdraw.
  Bidding is blind: vendors see how many offers exist, not the prices.
- `price` means: buy/accessory — what the customer pays; repair — the repair
  cost; sell — what the vendor pays; swap — the top-up the customer pays.

**Matching:** vendor type fits the request, the vendor serves that state (or
is nationwide), and it's ranked by stock held, being local, brand and repair
service. Up to 40 vendors are notified; the top 10 by email.

**Admin page "Requests":** `GET /api/admin/requests?status=&unmatched=true`,
`PATCH /api/admin/requests/:id { status: completed | cancelled, adminNotes }`,
and `POST /api/admin/requests/:id/match` to match again after onboarding a
vendor (requests nobody matched alert admins).

New notification types: `device_request`, `offer_received`,
`offer_accepted`, `offer_update`, `order_request`, `identity_update`,
`announcement`, `admin_alert`. Notifications may carry `orderRequest` and
`deviceRequest` ids to link to.

## 19. Categories, filters, bulk upload, flash sale

**Categories:** `GET /api/categories` returns the menu tree (Phones, Laptops,
Tablets, Smartwatches, Gaming → consoles / gaming PCs / controllers /
accessories / games, Audio → headphones / speakers / microphones, Cameras &
CCTV, Smart glasses, Projectors, Power & electrical → power banks / power
stations / solar / extensions / UPS, Networking, Accessories). Existing
catalog categories are unchanged.

`GET /api/categories/:slug` returns that category's **own filters with
counts** — build the filter sidebar from `filters.attributes`:

- select / multiselect / boolean: `options: [{ value, count }]` → send
  `a.<key>=value` (comma-separate for "any of")
- number: `min`, `max` → send `a.<key>_min` / `a.<key>_max`
- plus `brands`, `price` range and `children` (subcategories)

`GET /api/products?category=headphones&a.connectivity=Wireless&a.noiseCancelling=true&minPrice=&maxPrice=`
— a group slug (e.g. `audio`) includes its subcategories. Products now carry
`attributes`.

Admins add or edit categories and their filters with
`POST /api/categories/admin` and `PATCH /api/categories/admin/:slug` — new
categories appear without a deploy. Product create/edit takes `attributes`
and checks them against the category.

**Bulk upload:** `POST /api/products/bulk { csv, dryRun }` (admin, up to
1,000 rows) — columns `name, type, brand, category, priceUkUsed,
priceBrandNew, storage, colors, tags (| separated), ram, spec, badge, image,
inStock`; any other column is a filter for that category. Show the dry-run
result table (`rows[]` with an error per bad row), then upload for real.
Vendors: `POST /api/vendor/inventory/bulk { csv, dryRun }` with
`deviceName, buyPrice, sellPrice, condition, storage, category, quantity`.

**Flash sale:** products have `sale: { active, priceUkUsed, priceBrandNew,
startsAt, endsAt, label }` — when `active`, show the sale price with the
normal price struck through. `GET /api/products/flash-sale` returns live
sale items (ending soonest first), `upcoming` ones, and `serverTime` for the
countdown. `GET /api/products?onSale=true` filters the catalog. Admins:
`PATCH /api/products/:id { sale: {...} }` or
`POST /api/products/flash-sale { slugs, percentOff, startsAt?, endsAt, label }`,
and `DELETE /api/products/flash-sale` to end. Sale prices are used
automatically wherever prices are worked out.

## 20. Announcements, Snapchat check, maintenance tick

- **Announcements (admin):** `POST /api/admin/announcements { audience,
  title, message, sendEmail, dryRun }` — audiences `all_vendors`,
  `approved_vendors`, `pending_vendors`, `customers`, `everyone`. In-app for
  everyone; emails go out in the background (capped at 200 per send to fit
  the free email quota). `GET` shows progress.
- **Snapchat:** listings and requests take `snapchatStatus` (`works`,
  `banned`, `unknown`). Ask "Does Snapchat work on this phone?" on the sell
  form. Admins see a flag when it's banned.
- **Maintenance tick:** set `INTERNAL_CRON_SECRET` and point a free
  scheduler (cron-job.org) at `POST <backend>/api/internal/tick` every 10
  minutes with header `X-Cron-Secret: <secret>`. It closes expired requests
  on time (auto-picking offers) and keeps the free Render server awake.
  Everything still works without it.

## 21. Phone verification on WhatsApp

One button, **"Verify my number"**, works in two modes — the backend picks:

1. `POST /api/phone/verify { phone }` returns `method` and `whatsappUrl`.
   **Open the link.**
   - `method: "whatsapp"` (automatic, once the WhatsApp Cloud API is set up):
     the link opens WhatsApp with a code like `VN-7K3QXP` already typed.
     When the customer sends it **from that same number**, it's verified
     straight away and the bot replies "✅". Codes last 30 minutes.
   - `method: "manual"` (until then): the link opens a chat with the sales
     number. Staff verify the number from the admin panel.
2. Show progress from `GET /api/phone` (`phoneVerified`, `pending`) — poll
   it every few seconds while the customer is in WhatsApp, or wait for the
   `account_update` notification.

`GET /api/me` and each listing's `owner` include `phoneVerified` — show a
"Phone verified" tick. `409` means the number is verified on another
account.

**Admin page "Users":** `GET /api/admin/users?q=` (name, email or phone in
any format) and `?phonePending=true` (people waiting for staff to verify).
`PATCH /api/admin/users/:id/phone { verified: true }` verifies the number
they asked about (or send `phone` to set it); `{ verified: false }` undoes
it. Only verify a number you've seen message you on WhatsApp.

**Turning on automatic mode** (backend env vars, from the Meta developer
dashboard → your app → WhatsApp):

```
WHATSAPP_TOKEN=<permanent system-user access token>
WHATSAPP_PHONE_NUMBER_ID=<the number's Phone number ID>
WHATSAPP_APP_SECRET=<App settings → Basic → App secret>
WHATSAPP_VERIFY_NUMBER=234XXXXXXXXXX       # the verification number customers message
WHATSAPP_VERIFY_TOKEN=<any random string>   # also typed into Meta's webhook setup
WHATSAPP_API_VERSION=v23.0                  # optional; bump when Meta retires a version
```

In Meta's webhook settings use callback URL
`<backend>/api/whatsapp/webhook` with the same verify token, and subscribe
to **messages**. Use a separate number from the sales line — a number on
the Cloud API generally can't be used in the WhatsApp app at the same time.
Ordinary messages to the verification number get no bot reply.

## 22. Marketplace privacy changes (may need frontend updates)

TechNest is the middleman, so public listing responses no longer include
the seller's contact details:

- `GET /api/listings` and `GET /api/listings/:id` **no longer return
  `userPhone`, the owner's email, or `vendorProfile.phone`/`shopAddress`**
  to the public. `owner` now has `name`, `vendorProfile.businessName`,
  `city`, `states`, `identityVerified`, `phoneVerified`. Replace any "Call
  seller" / "WhatsApp seller" button with the WhatsApp checkout (section
  15). The listing's owner and admins still see everything.
- `bids[]` is empty for the public; vendors see only their own bid. Use
  `bidCount` for "3 offers so far". Owners still see every bid.
- `status=pending_review` / `rejected` / `removed` are admin-only (`403`),
  and those listings return `404` to anyone but the owner or an admin. Use
  `GET /api/listings/mine` for the seller's own listings in any status.
- The feed is paged: `?page=&limit=` (max 100), with `total` and `pages`
  in the response. The default is the first 100.
- `PATCH /api/vendor/upgrade` and `PATCH /api/vendor/verify` now require
  the `X-CSRF-Token` header like every other form (`apiFetch` sends it).

---

## Checklist

- [ ] Delete the seven local route folders (section 1)
- [ ] `/buy`, product page and cart read `/api/products`
- [ ] Checkout and callback read `json.data.*`, use `apiFetch`, and require login
- [ ] "Buy again" shelf and "Order again" button
- [ ] Accept button on vendor offers
- [ ] SwapModal: backend devices, `swap-quote`, `offeredDevice`, sign fix
- [ ] `/value`: backend devices and estimate; remove the browser Anthropic call
- [ ] Recommender: `apiFetch`, `data.reply`, send back `rawReply`
- [ ] /buy search box uses `/api/products/search`, with filter chips
- [ ] /value: description field and "Write it for me" (`/api/listings/assist`)
- [ ] Chat widget and repair helper: `apiFetch`, `data.reply`, links, WhatsApp
- [ ] Optional "AI" badge when `source` is `"ai"`; hide AI-only extras when `/api/ai/status` is off
- [ ] Notification types
- [ ] Admin: orders, fulfillment, transactions, products
- [ ] Admin: check chips and "AI review" on pending listings
- [ ] Admin: "Update prices" page (paste → read → review → preview → apply) and a devices table for manual edits
- [ ] Admin: AI on/off switch and usage
- [ ] /value: send `imei` (+ optional `imeiPhoto`), stop sending `imeiVerified`, show 400/409 IMEI errors
- [ ] "Check an IMEI" box and "Report a stolen device" page (section 13)
- [ ] Admin: stolen reports queue and the IMEI model-code (TAC) pages
- [ ] Handle `403 code: "email_not_verified"` with a "Resend link" button; "Confirm your email" banner while `isVerified` is false
- [ ] Login page toasts for `?verified=success` / `?verified=invalid`; "Forgot password?" link
- [ ] New `/reset-password` page (section 14)
- [ ] Checkout: "Chat with us on WhatsApp" + disabled "Pay on platform — Coming soon"; "My orders" (section 15)
- [ ] "Reserved" badge on held listings (`isReserved`)
- [ ] "Get verified" page with private uploads; "Verified seller" badge (section 16)
- [ ] Vendor form: business name, types, states, brands, repair services, CAC upload (section 17)
- [ ] "Post a request" flow, offers list with "Recommended", accept; vendor "Requests" inbox with offer form (section 18)
- [ ] Category menu from `/api/categories`; per-category filter sidebar; flash sale strip + countdown (section 19)
- [ ] Admin: WhatsApp orders, identity checks, requests, categories editor, bulk upload, flash sale, announcements
- [ ] "Does Snapchat work on this phone?" on the sell form
- [ ] "Verify my number" button + "Phone verified" tick; admin Users page with the phone waiting list (section 21)
- [ ] Listing pages: no seller phone/email any more, `bidCount`, paging (section 22)

## Backend setup (for whoever deploys it)

```
# .env
PAYSTACK_SECRET_KEY=sk_live_or_test_...
ANTHROPIC_API_KEY=sk-ant-...                 # optional; leave it out to run with no AI
PLATFORM_FEE_PERCENT=5                       # optional
AI_DAILY_LIMIT=500                           # optional: max AI calls per day for the whole app
AI_PER_IP_LIMIT=20                           # optional: AI replies per visitor per 15 min
SUPPORT_WHATSAPP=2348186450477               # optional: number shown by chat and repair helper
CLIENT_URL=https://technest11.vercel.app     # Paystack redirects to CLIENT_URL/checkout/callback
IMEI_HASH_SECRET=<random 32+ characters>     # required; set once and NEVER change it (stored IMEI hashes stop matching)
EMAIL_PROVIDER=brevo                         # brevo or resend; leave the three EMAIL_ lines out to log emails instead
EMAIL_API_KEY=xkeysib-...                    # from the provider's dashboard
EMAIL_FROM=you@yourdomain.com                # Brevo: a verified sender (a Gmail works); Resend: an address on a verified domain
EMAIL_FROM_NAME=TechNest                     # optional
INTERNAL_CRON_SECRET=<random string>         # optional: enables POST /api/internal/tick (section 20)
ONLINE_PAYMENTS=on                           # optional: only when online payment should go live (needs PAYSTACK_SECRET_KEY)
ANNOUNCEMENT_EMAIL_LIMIT=200                 # optional: max emails per announcement
```

```
npm run seed:products        # load the 94 catalog products (safe to re-run)
npm run prices:apply -- --db # one-time: push the dealer-list prices onto catalog products
npm run tac:import -- tac_full.csv  # one-time: load ~253k IMEI model codes (safe to re-run)
```

`tac_full.csv` is the free public list at
<https://github.com/MoazEb/tac-database> (download the file, then run the
command from a machine whose `.env` has `MONGO_URI` pointing at the live
database). It takes about 50 MB of the database. Re-run it with a newer copy
of the file every few months to pick up new phones.

Set the Paystack webhook to `<backend>/api/checkout/webhook`.

**Tests:** `npm test` runs every end-to-end suite in `test/` (about 270
checks, a few minutes). Each suite starts the real server against a
throwaway in-memory MongoDB with email, Paystack, Cloudinary and WhatsApp
mocked, so nothing real is sent and no real database is touched. The first
run downloads a MongoDB binary. Run one suite with `npm test -- imei` (or
`email`, `marketplace`, `phone`, `privacy`). Run it before every deploy.

**Updating prices later:** use the admin "Update prices" page (section 10).
Valuation prices now live in the database; on first start, the server fills
the database from the JSON files automatically.
`npm run prices:apply -- --db` still pushes the JSON files into the database,
but it overwrites quotes entered in the app. Use it only for a deliberate
bulk reset.
