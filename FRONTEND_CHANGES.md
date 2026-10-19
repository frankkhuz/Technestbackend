# Backend changes — what the frontend needs to do

**For:** whoever works on the `technest11` frontend
**Backend:** https://technestbackend-gue0.onrender.com (version 2.0.0)
**Try every endpoint:** https://technestbackend-gue0.onrender.com/api/docs
**Full details:** `API_INTEGRATION.md` sections 13–24 (section numbers below
point there)

The backend gained IMEI checks, email verification, WhatsApp checkout,
identity and phone verification, customer requests with vendor offers,
categories with filters, flash sales, bulk upload and more. A few changes
**break the current frontend** — do those first.

---

## 1. Broken right now — fix first

| What broke | Where in `technest11` | Fix |
|---|---|---|
| **Phone listings are rejected** — the backend requires the IMEI | `app/value/page.tsx` | Send `imei` with phone listings (spaces/dashes fine). Optionally send `imeiPhoto` (Cloudinary URL of the `*#06#` screen). **Stop sending `imeiVerified`** — the server sets it. Show the 400/409 `error` message (bad IMEI, reported stolen, already listed). §13 |
| **"WhatsApp seller" button has no number** — seller phones are no longer public | `app/marketplace/page.tsx` (~line 810, `l.userPhone`) | Replace with the TechNest WhatsApp order: `POST /api/order-requests { listingId, buyerName, buyerPhone }` → open `data.whatsappUrl`. §15 |
| **Owner email / vendor phone missing on listings** | `app/admin/page.tsx` (`owner?.email`, `vendorProfile?.phone`) | Admins still get them from `/api/admin/listings` and `/api/admin/vendors/pending` — use those there. Public listing `owner` now has only `name`, `vendorProfile.businessName/city/states`, `identityVerified`, `phoneVerified`. §22 |
| **Users get a 403 they can't fix** | every form that lists, buys, bids, posts a request | On `code: "email_not_verified"` show the `message` and a **Resend link** button → `POST /api/auth/resend-verification`. §14 |
| **Vendor forms rejected with "Invalid CSRF token"** if not using `apiFetch` | `app/become-vendor/page.tsx` | `PATCH /api/vendor/upgrade` and `/verify` now need the `X-CSRF-Token` header like every other form. §22 |

## 2. Changed responses

- **Listings** (`GET /api/listings`, `/api/listings/:id`): no `userPhone`,
  owner email or vendor phone for the public; `bids[]` is empty for the
  public and holds only the vendor's own bid for vendors — use `bidCount`;
  new `isReserved` / `isAvailable`, `imeiLast4`, `imeiCheck`, `snapchatStatus`.
  Paged: `?page=&limit=` (max 100) → `total`, `pages`. Statuses other than
  active/sold/swapped are admin-only. §22
- **Errors**: `{ success: false, message, code }`. `message` is always safe
  to show. Codes: `email_not_verified`, `service_unavailable` (show "try
  again" — it has a `Retry-After`), `invalid`, `duplicate`, `bad_json`,
  `too_large`, `cors`, `server_error`. §24
- **Products**: may carry `attributes` (category filters) and
  `sale: { active, priceUkUsed, priceBrandNew, endsAt, label }` — when
  `active`, show the sale price with the normal price struck through. §19
- **`GET /api/me`**: adds `identityVerified`, `identityStatus`, `phone`,
  `phoneVerified`.
- **Valuation** (`POST /api/valuation/estimate`): each `breakdown` line has
  a naira `amount`; adds `confidence`, `likelyRange`, `warnings`,
  `repairDeduction`. `min`/`max`/`value` mean the same as before. §23

## 3. Already built on the frontend — just check

- `/auth/forgot-password` and `/auth/reset-password` already call the right
  endpoints. The email link opens `/auth/reset-password?token=…`. Test it.
- `/auth/login`: the email-confirmation link lands here with
  `?verified=success` or `?verified=invalid` — show a toast for each. §14

## 4. Replace the frontend's own API routes

These Next.js routes talk to MongoDB directly. They don't work on Vercel
(no database settings there) and duplicate what the backend now does:

| Delete | Use instead |
|---|---|
| `app/api/vendor-requests` (on `/b2b`) | `/api/requests` — customer requests, vendor offers (§18) |
| `app/api/repair-vendors` (on `/fix`) | `GET /api/vendors/directory?type=repairs&state=Lagos` (§17) |
| `app/api/vendor-inventory` (on `/b2b`) | `/api/vendor/inventory` + `/api/vendor/inventory/bulk` (§19) |
| `app/api/listing-freshness` (marketplace, `/user`) | `isReserved` / `isAvailable` on each listing (§15) |

## 5. New things to build

**Customers**
- **Checkout** (`/checkout`): "Chat with us on WhatsApp" (`POST
  /api/order-requests` → open `whatsappUrl`) and a disabled "Pay online —
  Coming soon" (`GET /api/order-requests/options`). "My orders":
  `GET /api/order-requests/mine`. §15
- **Sell form** (`/value`): cosmetic grade, "What's not working?"
  checkboxes (`GET /api/valuation/conditions`), "Does Snapchat work?",
  "Signed out of iCloud/Google?"; show line amounts, confidence and
  likely range. §23
- **Post a request & compare offers**: `POST /api/requests`, offers come
  best-first with `recommended`; accept → open `whatsappUrl`. §18
- **Get verified** (ID + selfie, private uploads) → "Verified seller"
  badge. §16
- **Verify my number** (WhatsApp) → "Phone verified" tick. §21
- **IMEI check** box and **report a stolen device** page. §13
- **Category menu & filter sidebar** from `/api/categories` and
  `/api/categories/:slug`; **flash sale** strip from
  `/api/products/flash-sale` (use `serverTime` for the countdown). §19
- **Reserved** badge on listings held for a buyer.

**Vendors**
- Vendor form: business name, type (phones / gadgets / accessories /
  repairs), states, brands, repair services, CAC certificate upload. §17
- Requests inbox + offer form: `/api/requests/for-vendor`,
  `POST /api/requests/:id/offers`. Bulk stock upload. §18, §19

**Admin**
- WhatsApp orders (§15), identity checks (§16), requests (§18), stolen
  reports and IMEI model codes (§13), users & phone waiting list (§21),
  categories editor, bulk product upload, flash sale (§19), announcements
  (§20), estimate accuracy report (§23), listing review flags (§10).

**Everywhere**
- Notifications: handle the new `type`s (`device_request`,
  `offer_received`, `offer_accepted`, `offer_update`, `order_request`,
  `identity_update`, `account_update`, `listing_update`,
  `stolen_device_alert`, `stolen_report_update`, `announcement`,
  `admin_alert`). Links: `listing`, `transaction`, `order`, `orderRequest`,
  `deviceRequest` ids.
- Optional status banner from `GET /api/health`.

## 6. Testing tips

- In the docs, log in with `POST /api/auth/login` → **Try it out**; the
  session cookies are set for you. For POST / PATCH / DELETE, click
  **Authorize** and paste the `csrfToken` from the login response into
  `csrfHeader (X-CSRF-Token)`.
- Email works on the live backend (Brevo). Phone verification is manual
  until the WhatsApp Cloud API is set up — staff verify from the admin
  panel. Online payment is off (WhatsApp checkout instead).
- Backend tests: `npm test` in the backend repo.
