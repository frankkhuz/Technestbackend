// Catalog categories and the filters each one offers. Each category
// defines its own attributes (connectivity for headphones, lumens for
// projectors…) instead of one generic filter set, and admins can add
// categories or attributes from the admin panel — no code change needed.
//
// Product.category holds a category slug. Groups (parent: null with
// children) can also hold products directly; older catalog items in
// "audio", "power" and "accessory" do.
const Category = require("../models/Category");
const Product = require("../models/Product");

const sel = (key, label, options, extra = {}) => ({ key, label, type: "select", options, ...extra });
const multi = (key, label, options, extra = {}) => ({ key, label, type: "multiselect", options, ...extra });
const num = (key, label, unit, extra = {}) => ({ key, label, type: "number", unit, ...extra });
const bool = (key, label, extra = {}) => ({ key, label, type: "boolean", ...extra });

const OS_PHONE = sel("os", "Operating system", ["iOS", "Android"]);
const NETWORK = sel("network", "Network", ["5G", "4G"]);
const STORAGE = sel("storage", "Storage", ["64GB", "128GB", "256GB", "512GB", "1TB", "2TB"]);
const RAM = sel("ram", "RAM", ["4GB", "8GB", "12GB", "16GB", "32GB", "64GB"]);
const CPU = sel("processor", "Processor", [
  "Intel Core i3", "Intel Core i5", "Intel Core i7", "Intel Core i9", "Intel Core Ultra",
  "AMD Ryzen 3", "AMD Ryzen 5", "AMD Ryzen 7", "AMD Ryzen 9",
  "Apple M1", "Apple M2", "Apple M3", "Apple M4", "Snapdragon X",
]);
const GPU = sel("gpu", "Graphics", ["Integrated", "NVIDIA RTX 3050/3060", "NVIDIA RTX 4050/4060", "NVIDIA RTX 4070 or higher", "NVIDIA RTX 50 series", "AMD Radeon"]);
const PLATFORM = sel("platform", "Platform", ["PlayStation 5", "PlayStation 4", "Xbox Series X|S", "Xbox One", "Nintendo Switch", "PC", "Mobile", "Multi-platform"]);
const COMPAT = multi("compatibleWith", "Works with", ["iPhone", "Samsung", "Other Android", "iPad", "MacBook", "Windows laptop", "Universal"]);
const WIRELESS = sel("connectivity", "Connectivity", ["Wireless", "Wired", "Wireless + wired"]);

const PHONE_ATTRS = [OS_PHONE, NETWORK, num("screenSize", "Screen size", "in"), bool("dualSim", "Dual SIM")];

const DEFAULT_CATEGORIES = [
  // ── Phones (tiers kept from the original catalog) ────────────────────────
  { slug: "phones", name: "Phones", order: 10 },
  { slug: "flagship", name: "Flagship phones", parent: "phones", order: 1, attributes: PHONE_ATTRS },
  { slug: "mid-range", name: "Mid-range phones", parent: "phones", order: 2, attributes: PHONE_ATTRS },
  { slug: "budget", name: "Budget phones", parent: "phones", order: 3, attributes: PHONE_ATTRS },

  // ── Computing ────────────────────────────────────────────────────────────
  {
    slug: "laptop", name: "Laptops", order: 20,
    attributes: [
      sel("os", "Operating system", ["Windows", "macOS", "ChromeOS", "Linux"]),
      CPU, RAM, STORAGE, sel("storageType", "Storage type", ["SSD", "HDD", "SSD + HDD"]), GPU,
      num("screenSize", "Screen size", "in"),
      multi("bestFor", "Best for", ["School", "Business", "Gaming", "Design & video", "Programming"]),
    ],
  },
  {
    slug: "tablet", name: "Tablets", order: 30,
    attributes: [
      sel("os", "Operating system", ["iPadOS", "Android", "Windows"]),
      STORAGE, sel("cellular", "Connectivity", ["Wi-Fi only", "Wi-Fi + Cellular"]),
      num("screenSize", "Screen size", "in"), bool("stylusSupport", "Stylus support"),
    ],
  },
  {
    slug: "watch", name: "Smartwatches & wearables", order: 40,
    attributes: [
      sel("type", "Type", ["Smartwatch", "Fitness band", "Kids watch", "Smart ring"]),
      sel("worksWith", "Works with", ["iPhone only", "Android only", "iPhone & Android"]),
      num("caseSize", "Case size", "mm"), bool("gps", "Built-in GPS"), bool("cellular", "Cellular (eSIM)"),
    ],
  },

  // ── Gaming ───────────────────────────────────────────────────────────────
  { slug: "gaming", name: "Gaming", order: 50 },
  {
    slug: "console", name: "Consoles", parent: "gaming", order: 1,
    attributes: [
      sel("platform", "Console", ["PlayStation 5", "PlayStation 5 Pro", "PlayStation 4", "Xbox Series X", "Xbox Series S", "Xbox One", "Nintendo Switch", "Nintendo Switch 2", "Steam Deck", "Other handheld"]),
      sel("edition", "Edition", ["Disc", "Digital"]), STORAGE, num("controllersIncluded", "Controllers included", ""),
    ],
  },
  {
    slug: "gaming-pc", name: "Gaming PCs & laptops", parent: "gaming", order: 2,
    attributes: [sel("formFactor", "Type", ["Desktop tower", "Gaming laptop", "Mini PC"]), CPU, GPU, RAM, STORAGE, num("refreshRate", "Screen refresh rate", "Hz")],
  },
  {
    slug: "controller", name: "Controllers & gamepads", parent: "gaming", order: 3,
    attributes: [PLATFORM, WIRELESS, bool("official", "Official / first-party")],
  },
  {
    slug: "gaming-accessory", name: "Gaming accessories", parent: "gaming", order: 4,
    attributes: [
      sel("type", "Type", ["Headset", "Keyboard", "Mouse", "Monitor", "Chair", "VR headset", "Racing wheel", "Charging dock", "Capture card", "Other"]),
      PLATFORM, WIRELESS, bool("rgb", "RGB lighting"),
    ],
  },
  {
    slug: "game", name: "Games", parent: "gaming", order: 5,
    attributes: [PLATFORM, sel("format", "Format", ["Disc", "Digital code", "Cartridge"]), sel("genre", "Genre", ["Sports", "Action", "Shooter", "Racing", "Fighting", "Adventure", "Kids & family", "Other"])],
  },

  // ── Audio ────────────────────────────────────────────────────────────────
  { slug: "audio", name: "Audio", order: 60 },
  {
    slug: "headphones", name: "Headphones & earphones", parent: "audio", order: 1,
    attributes: [
      sel("type", "Type", ["In-ear / earbuds", "On-ear", "Over-ear", "Neckband", "Open-ear / bone conduction"]),
      WIRELESS, bool("noiseCancelling", "Active noise cancelling"),
      multi("bestFor", "Best for", ["Everyday", "Sports & gym", "Gaming", "Calls & work", "Studio"]),
      num("batteryLife", "Battery life", "hours"), bool("waterResistant", "Sweat / water resistant"),
    ],
  },
  {
    slug: "speaker", name: "Speakers", parent: "audio", order: 2,
    attributes: [
      sel("type", "Type", ["Portable Bluetooth", "Smart speaker", "Soundbar", "Party speaker", "Bookshelf", "Home theatre system"]),
      multi("connectivity", "Connectivity", ["Bluetooth", "Wi-Fi", "AUX", "HDMI / optical", "USB"]),
      num("power", "Power output", "W"), num("batteryLife", "Battery life", "hours"), bool("waterproof", "Waterproof"),
    ],
  },
  {
    slug: "microphone", name: "Microphones", parent: "audio", order: 3,
    attributes: [
      sel("type", "Type", ["Wireless lapel", "Wired lavalier", "USB desktop", "XLR studio", "Shotgun", "Handheld"]),
      multi("connector", "Connects with", ["USB-C", "Lightning", "3.5mm", "XLR", "Wireless receiver"]),
      multi("bestFor", "Best for", ["Vlogging", "Podcasting", "Streaming", "Singing", "Interviews", "Church & events"]),
      bool("noiseCancelling", "Noise cancelling"),
    ],
  },

  // ── Cameras & CCTV ───────────────────────────────────────────────────────
  { slug: "cameras", name: "Cameras & CCTV", order: 70 },
  {
    slug: "camera", name: "Cameras", parent: "cameras", order: 1,
    attributes: [
      sel("type", "Type", ["Mirrorless", "DSLR", "Action camera", "Compact", "Instant", "360° camera", "Vlogging camera"]),
      sel("videoResolution", "Video", ["1080p", "4K", "5K+", "8K"]), num("megapixels", "Megapixels", "MP"),
      bool("lensIncluded", "Lens included"),
    ],
  },
  {
    slug: "security", name: "CCTV & security cameras", parent: "cameras", order: 2,
    attributes: [
      sel("type", "Type", ["Wi-Fi camera", "4G / solar camera", "IP camera kit (NVR)", "Analog kit (DVR)", "Video doorbell", "Dash cam"]),
      sel("resolution", "Resolution", ["2MP (1080p)", "3MP", "4MP (2K)", "5MP", "8MP (4K)"]),
      num("channels", "Cameras in kit", ""), bool("nightVision", "Night vision (colour)"), bool("outdoor", "Outdoor / weatherproof"),
      sel("power", "Power", ["Mains", "Solar", "Battery", "PoE"]), multi("storage", "Recording", ["SD card", "Cloud", "NVR / DVR"]),
      bool("phoneViewing", "View on phone"),
    ],
  },
  {
    slug: "drone", name: "Drones & gimbals", parent: "cameras", order: 3,
    attributes: [sel("type", "Type", ["Drone", "Gimbal", "Pocket camera"]), sel("videoResolution", "Video", ["1080p", "2.7K", "4K", "5K+"]), num("flightTime", "Flight time", "min")],
  },

  // ── Smart glasses and projectors ─────────────────────────────────────────
  {
    slug: "smart-glasses", name: "Smart glasses", order: 80,
    description: "Meta Ray-Ban and other glasses with cameras, audio or displays",
    attributes: [
      sel("type", "Type", ["Camera glasses", "Audio glasses", "AR / display glasses", "VR headset"]),
      multi("features", "Features", ["Camera", "Open-ear speakers", "Display", "AI assistant", "Prescription-ready", "Sunglass lenses"]),
      sel("worksWith", "Works with", ["iPhone & Android", "iPhone only", "Android only"]), num("batteryLife", "Battery life", "hours"),
    ],
  },
  {
    slug: "projector", name: "Projectors", order: 90,
    attributes: [
      sel("type", "Type", ["Mini / portable", "Home cinema", "Office", "Short-throw"]),
      sel("nativeResolution", "Native resolution", ["480p", "720p", "1080p", "4K"]), num("brightness", "Brightness", "lumens"),
      bool("smart", "Built-in apps (Netflix, YouTube)"), multi("connectivity", "Connectivity", ["HDMI", "USB", "Wi-Fi", "Bluetooth", "Screen mirroring"]),
      bool("battery", "Built-in battery"),
    ],
  },

  // ── Power & electrical ───────────────────────────────────────────────────
  { slug: "power", name: "Power & electrical", order: 100 },
  {
    slug: "power-bank", name: "Power banks", parent: "power", order: 1,
    attributes: [num("capacity", "Capacity", "mAh"), num("output", "Max output", "W"), bool("fastCharging", "Fast charging"), multi("ports", "Ports", ["USB-C", "USB-A", "Lightning", "Wireless pad", "Built-in cable"])],
  },
  {
    slug: "power-station", name: "Power stations & power tanks", parent: "power", order: 2,
    description: "Rechargeable generators that run phones, laptops, TVs, fans and more",
    attributes: [
      num("capacity", "Capacity", "Wh"), num("output", "Output", "W"), bool("solarCharging", "Solar charging"),
      sel("batteryType", "Battery", ["LiFePO4", "Lithium-ion", "Lead-acid"]), num("acOutlets", "AC sockets", ""),
    ],
  },
  { slug: "solar-panel", name: "Solar panels", parent: "power", order: 3, attributes: [num("wattage", "Wattage", "W"), bool("foldable", "Foldable / portable")] },
  {
    slug: "extension", name: "Extension sockets & surge protectors", parent: "power", order: 4,
    attributes: [num("outlets", "Sockets", ""), num("usbPorts", "USB ports", ""), bool("surgeProtection", "Surge protection"), num("cableLength", "Cable length", "m"), bool("individualSwitches", "Individual switches")],
  },
  {
    slug: "ups", name: "UPS & inverters", parent: "power", order: 5,
    attributes: [sel("type", "Type", ["UPS", "Inverter", "Inverter + battery kit"]), num("capacity", "Capacity", "VA"), bool("pureSineWave", "Pure sine wave")],
  },

  // ── Networking ───────────────────────────────────────────────────────────
  { slug: "networking", name: "Internet & networking", order: 110 },
  { slug: "router", name: "Routers", parent: "networking", order: 1, attributes: [sel("wifi", "Wi-Fi", ["Wi-Fi 5", "Wi-Fi 6", "Wi-Fi 6E", "Wi-Fi 7"]), bool("simSupport", "SIM card slot"), bool("mesh", "Mesh system")] },
  { slug: "mifi", name: "MiFi & hotspots", parent: "networking", order: 2, attributes: [NETWORK, sel("unlocked", "Network lock", ["Unlocked (any SIM)", "Locked to one network"]), num("batteryLife", "Battery life", "hours")] },

  // ── Accessories (older catalog items sit on the group itself) ────────────
  { slug: "accessory", name: "Phone & laptop accessories", order: 120 },
  { slug: "charger", name: "Chargers & adapters", parent: "accessory", order: 1, attributes: [sel("type", "Type", ["Wall charger", "Car charger", "Wireless / MagSafe", "Laptop charger"]), num("output", "Output", "W"), COMPAT] },
  { slug: "cable", name: "Cables", parent: "accessory", order: 2, attributes: [sel("connector", "Connector", ["USB-C to USB-C", "USB-C to Lightning", "USB-A to Lightning", "USB-A to USB-C", "Micro-USB", "HDMI"]), num("length", "Length", "m")] },
  { slug: "case", name: "Cases & screen protectors", parent: "accessory", order: 3, attributes: [sel("type", "Type", ["Case", "Screen protector", "Camera protector", "Laptop sleeve / bag"]), COMPAT] },
  { slug: "keyboard", name: "Keyboards & mice", parent: "accessory", order: 4, attributes: [sel("type", "Type", ["Keyboard", "Mouse", "Keyboard + mouse", "Tablet keyboard case"]), WIRELESS, COMPAT] },
  { slug: "stylus", name: "Styluses", parent: "accessory", order: 5, attributes: [COMPAT, bool("pressureSensitive", "Pressure sensitive")] },
];

/** Inserts any default categories that don't exist yet. Never overwrites admin edits. */
const ensureDefaultCategories = async () => {
  const existing = new Set((await Category.find().select("slug")).map((c) => c.slug));
  const missing = DEFAULT_CATEGORIES.filter((c) => !existing.has(c.slug));
  if (missing.length) await Category.insertMany(missing.map((c) => ({ parent: null, attributes: [], ...c })));
  return missing.length;
};

/** The slug plus all its active children's slugs, for "show me everything in Audio". */
const expandCategory = async (slug) => {
  const children = await Category.find({ parent: slug, isActive: true }).select("slug");
  return [slug, ...children.map((c) => c.slug)];
};

/**
 * Checks product attributes against the category's definitions. Unknown
 * keys and values outside a select's options are rejected so filters stay
 * clean. Returns { attributes } (normalized) or { error }.
 */
const validateAttributes = (category, input) => {
  if (input === undefined || input === null) return { attributes: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { error: "attributes must be an object" };
  const defs = new Map((category?.attributes || []).map((a) => [a.key, a]));
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === "" || raw === null || raw === undefined) continue;
    const def = defs.get(key);
    if (!def) return { error: `"${key}" isn't a filter for ${category?.name || "this category"}` };
    const optionFor = (v) => def.options.find((o) => o.toLowerCase() === String(v).trim().toLowerCase());
    if (def.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `${def.label} must be a number` };
      out[key] = n;
    } else if (def.type === "boolean") {
      const v = typeof raw === "boolean" ? raw : ["true", "yes", "1"].includes(String(raw).toLowerCase()) ? true : ["false", "no", "0"].includes(String(raw).toLowerCase()) ? false : null;
      if (v === null) return { error: `${def.label} must be yes or no` };
      out[key] = v;
    } else if (def.type === "select") {
      const v = optionFor(raw);
      if (!v) return { error: `${def.label} must be one of: ${def.options.join(", ")}` };
      out[key] = v;
    } else if (def.type === "multiselect") {
      const list = Array.isArray(raw) ? raw : String(raw).split(/[|;,]/);
      const vals = [];
      for (const item of list.map((s) => String(s).trim()).filter(Boolean)) {
        const v = optionFor(item);
        if (!v) return { error: `${def.label}: "${item}" must be one of: ${def.options.join(", ")}` };
        vals.push(v);
      }
      if (vals.length) out[key] = [...new Set(vals)];
    } else {
      out[key] = String(raw).trim().slice(0, 100);
    }
  }
  return { attributes: out };
};

/**
 * Turns ?a.connectivity=Wireless&a.capacity_min=10000 style query params
 * into a Mongo filter on product attributes. Unknown keys are ignored.
 */
const attributeFilter = (category, query) => {
  const defs = new Map((category?.attributes || []).map((a) => [a.key, a]));
  const filter = {};
  for (const [param, value] of Object.entries(query)) {
    if (!param.startsWith("a.") || value === "") continue;
    let key = param.slice(2);
    let bound = null;
    const m = key.match(/^(.*)_(min|max)$/);
    if (m && defs.get(m[1])?.type === "number") [, key, bound] = m;
    const def = defs.get(key);
    if (!def) continue;
    const path = `attributes.${key}`;
    if (def.type === "number" && bound) {
      const n = Number(value);
      if (Number.isFinite(n)) filter[path] = { ...(filter[path] || {}), [bound === "min" ? "$gte" : "$lte"]: n };
    } else if (def.type === "boolean") {
      filter[path] = String(value) === "true";
    } else {
      // Comma-separated = any of these
      const values = String(value).split(",").map((v) => v.trim()).filter(Boolean);
      filter[path] = { $in: values };
    }
  }
  return filter;
};

/**
 * Filter counts for a category page: how many products have each option,
 * number ranges, brands and price range — computed from what's in stock.
 */
const categoryFacets = async (category, slugs) => {
  const match = { isActive: true, category: { $in: slugs } };
  const facetStages = {
    brands: [{ $group: { _id: "$brand", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
    price: [{ $group: { _id: null, min: { $min: "$priceUkUsed" }, max: { $max: "$priceUkUsed" } } }],
    total: [{ $count: "n" }],
  };
  for (const a of category.attributes || []) {
    if (a.filterable === false) continue;
    const path = `$attributes.${a.key}`;
    if (a.type === "number")
      facetStages[`a_${a.key}`] = [{ $match: { [`attributes.${a.key}`]: { $type: "number" } } }, { $group: { _id: null, min: { $min: path }, max: { $max: path } } }];
    else if (a.type === "multiselect")
      facetStages[`a_${a.key}`] = [{ $unwind: path }, { $group: { _id: path, count: { $sum: 1 } } }];
    else if (a.type !== "text")
      facetStages[`a_${a.key}`] = [{ $match: { [`attributes.${a.key}`]: { $exists: true } } }, { $group: { _id: path, count: { $sum: 1 } } }];
  }
  const [result] = await Product.aggregate([{ $match: match }, { $facet: facetStages }]);
  return {
    total: result.total[0]?.n || 0,
    brands: result.brands.map((b) => ({ value: b._id, count: b.count })),
    price: result.price[0] ? { min: result.price[0].min, max: result.price[0].max } : null,
    attributes: (category.attributes || [])
      .filter((a) => a.filterable !== false && a.type !== "text")
      .map((a) => {
        const rows = result[`a_${a.key}`] || [];
        const base = { key: a.key, label: a.label, type: a.type, unit: a.unit || undefined, param: `a.${a.key}` };
        if (a.type === "number") return { ...base, min: rows[0]?.min ?? null, max: rows[0]?.max ?? null, params: [`a.${a.key}_min`, `a.${a.key}_max`] };
        const counts = new Map(rows.map((r) => [String(r._id), r.count]));
        const options = a.type === "boolean" ? ["true", "false"] : a.options;
        return { ...base, options: options.map((o) => ({ value: o, count: counts.get(String(o)) || 0 })) };
      }),
  };
};

module.exports = {
  DEFAULT_CATEGORIES,
  ensureDefaultCategories,
  expandCategory,
  validateAttributes,
  attributeFilter,
  categoryFacets,
};
