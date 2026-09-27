// Built-in answers for the site chat. These work with no AI at all, and are
// also given to the AI as its facts about how TechNest works.
const SUPPORT_WHATSAPP = () => process.env.SUPPORT_WHATSAPP || "2348186450477";

const FAQ = [
  {
    id: "sell",
    match: /\b(sell\w*|list(ing|ings)?|post (my|a)|how much (is|can i get|will i get)|worth|valu\w*)\b/i,
    answer:
      "To sell, go to Value & Sell, pick your device and describe its condition — you'll get an instant price range. Add photos and publish; an admin reviews new listings before they go live, then verified vendors can send you offers.",
    links: [{ label: "Value & sell a device", href: "/value" }],
  },
  {
    id: "swap",
    match: /\b(swap\w*|exchang\w*|trade[- ]?ins?|upgrad\w*)\b/i,
    answer:
      "To swap, open a swap listing in the marketplace and tap Swap. Tell us about your device and we'll value it and show the difference: if their device is worth more, you pay the top-up securely at checkout; if yours is worth more, the seller owes you the difference. The seller then accepts or declines.",
    links: [
      { label: "Browse swap listings", href: "/marketplace?type=swap" },
      { label: "Value your device", href: "/value?type=swap" },
    ],
  },
  {
    id: "buy",
    match: /\b(buy\w*|purchas\w*|order a|shop\w*|price of|in stock|available)\b/i,
    answer:
      "You can buy UK-used or brand-new phones and gadgets from the Buy page, or buy directly from other users in the marketplace. Payment is by Paystack, and delivery details are taken at checkout.",
    links: [
      { label: "Buy a device", href: "/buy" },
      { label: "Marketplace", href: "/marketplace" },
    ],
  },
  {
    id: "payment",
    match: /\b(pay|paid|paying|payments?|paystack|cards?|transfers?|refund\w*|charged|debited)\b/i,
    answer:
      "All payments go through Paystack at checkout — never pay a seller directly or outside TechNest. If a payment went through but your order still shows pending, open it from your orders page to refresh it, or message support on WhatsApp with your order reference (it starts with TN-).",
    links: [{ label: "My account", href: "/user" }],
  },
  {
    id: "delivery",
    match: /\b(deliver\w*|ship\w*|arrive|when will|track\w*|dispatch\w*)\b/i,
    answer:
      "Once your order is paid, our team processes and ships it — you'll get a notification when it's on its way and when it's delivered.",
    links: [{ label: "My account", href: "/user" }],
  },
  {
    id: "imei",
    match: /\b(imei|stolen|blacklist\w*|serial)\b/i,
    answer:
      "When you list a phone we check that the IMEI number is valid (dial *#06# to see it). This catches typos and fake numbers; it isn't a stolen-phone database check, so always meet in safe places and keep the deal on TechNest.",
    links: [],
  },
  {
    id: "battery",
    match: /\b(battery health|battery|bh)\b/i,
    answer:
      "Battery health affects the price: 95%+ counts as like-new, and each step below that (90, 85, 80%) lowers the valuation. On iPhone, find it in Settings → Battery → Battery Health.",
    links: [{ label: "Value a device", href: "/value" }],
  },
  {
    id: "vendor",
    match: /\b(vendors?|dealers?|business\w*|bids?|bidding|offers?|resell\w*)\b/i,
    answer:
      "Vendors are verified businesses that can make offers on sell listings and see swap requests. Sellers get a notification for each offer and can accept one from their account page. To become a vendor, register your business and an admin will verify it.",
    links: [{ label: "Become a vendor", href: "/become-vendor" }],
  },
  {
    id: "repair",
    match: /\b(repair\w*|fix\w*|broken|crack\w*|not charging|won'?t (turn|charge)|screens?|water)\b/i,
    answer:
      "For a broken or misbehaving device, try Fix My Device — it walks you through quick checks and shows typical repair prices, and you can book a technician on WhatsApp.",
    links: [{ label: "Fix my device", href: "/fix" }],
  },
  {
    id: "account",
    match: /\b(passwords?|log ?in|sign ?in|accounts?|regist\w*|sign ?up|verify email)\b/i,
    answer:
      "You can sign in or create an account from the top of any page. If you've forgotten your password, use “Forgot password” on the sign-in page.",
    links: [{ label: "Sign in", href: "/auth/login" }],
  },
  {
    id: "safety",
    match: /\b(scam\w*|safe\w*|trust\w*|fake|fraud\w*)\b/i,
    answer:
      "Stay safe: pay only through TechNest checkout, don't share bank details or move the chat to other apps, and inspect the device before completing a swap or cash deal. Report anything suspicious to support.",
    links: [],
  },
];

const GREETING = /^\s*(hi|hello|hey|good (morning|afternoon|evening)|howdy|yo)\b/i;
const ACCOUNT_QUESTION = /\b(my (order|orders|swap|swaps|listing|listings|deal|deals|offer|offers|payment|item)|where is my|status|track)\b/i;

// Page links the chat is allowed to send people to
const ALLOWED_LINKS = new Set([
  "/", "/buy", "/marketplace", "/marketplace?type=swap", "/marketplace?type=sell", "/value",
  "/value?type=swap", "/user", "/fix", "/recommend", "/become-vendor", "/auth/login",
  "/auth/register", "/cart", "/checkout", "/transactions", "/about",
]);

module.exports = { FAQ, GREETING, ACCOUNT_QUESTION, ALLOWED_LINKS, SUPPORT_WHATSAPP };
