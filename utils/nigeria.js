// Reference data for Nigeria: states (for vendor coverage and request
// matching) and normalizing what people type into a state name.
const STATES = [
  "Abia", "Adamawa", "Akwa Ibom", "Anambra", "Bauchi", "Bayelsa", "Benue",
  "Borno", "Cross River", "Delta", "Ebonyi", "Edo", "Ekiti", "Enugu", "FCT",
  "Gombe", "Imo", "Jigawa", "Kaduna", "Kano", "Katsina", "Kebbi", "Kogi",
  "Kwara", "Lagos", "Nasarawa", "Niger", "Ogun", "Ondo", "Osun", "Oyo",
  "Plateau", "Rivers", "Sokoto", "Taraba", "Yobe", "Zamfara",
];

const ALIASES = { abuja: "FCT", "federal capital territory": "FCT", "fct abuja": "FCT" };

const squash = (s) => String(s || "").toLowerCase().replace(/\bstate\b/g, "").replace(/[^a-z ]/g, "").trim();
const BY_KEY = new Map(STATES.map((s) => [squash(s), s]));

/** "lagos state" → "Lagos", "Abuja" → "FCT", unknown → null */
const normalizeState = (value) => {
  const key = squash(value);
  return BY_KEY.get(key) || ALIASES[key] || null;
};

/** Normalizes a list, dropping unknown entries. */
const normalizeStates = (values) =>
  [...new Set((Array.isArray(values) ? values : [values]).map(normalizeState).filter(Boolean))];

module.exports = { STATES, normalizeState, normalizeStates };
