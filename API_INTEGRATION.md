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
| POST | `/api/listings` | Unchanged, plus an optional **`description`** field (max 1000 characters). New listings wait for admin approval (`pending_review`) |
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
  at random. Keep the Luhn `validateIMEI` check. Real stolen-phone checks need
  an IMEI blacklist service, which we can add on the backend later.

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
`buy_request`, `transaction_update`, `order_paid`, `listing_sold`, `offer_accepted`.
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
medium = amber, info = grey).

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
```

```
npm run seed:products        # load the 94 catalog products (safe to re-run)
npm run prices:apply -- --db # one-time: push the dealer-list prices onto catalog products
```

Set the Paystack webhook to `<backend>/api/checkout/webhook`.

**Updating prices later:** use the admin "Update prices" page (section 10).
Valuation prices now live in the database; on first start, the server fills
the database from the JSON files automatically.
`npm run prices:apply -- --db` still pushes the JSON files into the database,
but it overwrites quotes entered in the app. Use it only for a deliberate
bulk reset.
