/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo Fuel — validation, image checks, and AI-result normalisation
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Pure functions (no I/O) shared by the two Fuel endpoints:
 *
 *    · validateMealPayload()   — the ATHLETE-CONFIRMED meal the client asks
 *                                us to store. Never trust it just because it
 *                                originated from an AI suggestion in our own
 *                                frontend: every number and string is
 *                                re-validated here.
 *    · validateImagePayload()  — the photo sent for AI analysis. Type is
 *                                decided by sniffing magic bytes, not by the
 *                                client-declared MIME.
 *    · normalizeAnalysis()     — the model's structured output. Anything that
 *                                does not match the contract fails safely
 *                                (returns null) instead of reaching the
 *                                athlete half-formed.
 *
 *  Nutrition values from a photograph are ESTIMATES. normalizeAnalysis()
 *  therefore rounds to sensible increments so the UI never shows false
 *  precision such as "623.7 kcal".
 */

export const FUEL_LIMITS = Object.freeze({
  MAX_ITEMS: 30,
  MAX_MEAL_BODY_CHARS: 32768,
  MAX_AI_ITEMS: 12,
  MAX_NAME_LEN: 120,
  MAX_NOTE_LEN: 500,
  MAX_UNIT_LEN: 30,
  MAX_STATEMENT_LEN: 160,
  MAX_STATEMENTS: 6,
  // Per-item / per-meal ceilings (also enforced by CHECK constraints).
  MAX_CALORIES: 10000,
  MAX_CARBS_G: 1500,
  MAX_PROTEIN_G: 1000,
  MAX_FAT_G: 1000,
  MAX_GRAMS: 20000,
  MAX_QUANTITY: 100000,
  // Image limits. Vercel rejects request bodies over 4.5 MB, and base64
  // inflates binary by ~4/3, so the decoded photo must stay well under
  // ~3.3 MB. The client already downsizes to ~1280 px JPEG (typically a few
  // hundred KB); these are the server-side hard stops.
  MAX_IMAGE_BYTES: 2_621_440,
  MAX_IMAGE_BASE64_CHARS: 3_600_000,
  MAX_IMAGE_DIMENSION: 4096,
  MIN_IMAGE_DIMENSION: 32,
  // How far a client-supplied local_date may sit from server "now".
  MAX_DAYS_BACK: 7,
  MAX_DAYS_FORWARD: 1
});

export const MEAL_SOURCES = Object.freeze(["ai_photo", "manual", "repeated"]);
export const MEAL_TYPES = Object.freeze(["breakfast", "lunch", "dinner", "snack", "other"]);
export const GOAL_MODES = Object.freeze(["performance", "maintain", "weight_management"]);
export const ALLOWED_IMAGE_MIMES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);
const CONFIDENCE = Object.freeze(["low", "medium", "high"]);

/* ───────────────────────────── text helpers ─────────────────────────── */

// Trim, drop control characters, collapse runs of whitespace, cap length.
export function cleanText(value, maxLen) {
  if (typeof value !== "string") return "";
  const stripped = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.length > maxLen ? stripped.slice(0, maxLen).trim() : stripped;
}

/* ──────────────────────────── number helpers ────────────────────────── */

// Accepts a finite number or a plain numeric string. Anything else — NaN,
// Infinity, "", "abc", booleans, objects — is rejected (returns null).
export function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/* Reads a REQUIRED bounded, non-negative number. */
function requiredAmount(source, key, max, errors, label) {
  const n = toFiniteNumber(source ? source[key] : undefined);
  if (n === null) { errors.push(`${label} must be a number.`); return 0; }
  if (n < 0) { errors.push(`${label} can't be negative.`); return 0; }
  if (n > max) { errors.push(`${label} is too large.`); return 0; }
  return round1(n);
}

/* Reads an OPTIONAL bounded, non-negative number (null when absent). */
function optionalAmount(source, key, max, errors, label) {
  const raw = source ? source[key] : undefined;
  if (raw === undefined || raw === null || raw === "") return null;
  const n = toFiniteNumber(raw);
  if (n === null) { errors.push(`${label} must be a number.`); return null; }
  if (n < 0) { errors.push(`${label} can't be negative.`); return null; }
  if (n > max) { errors.push(`${label} is too large.`); return null; }
  return Math.round(n * 100) / 100;
}

/* ──────────────────────────── meal payload ──────────────────────────── */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateLocalDate(value, now) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  const dayMs = 86_400_000;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.round((parsed.getTime() - todayUtc) / dayMs);
  if (diffDays < -FUEL_LIMITS.MAX_DAYS_BACK || diffDays > FUEL_LIMITS.MAX_DAYS_FORWARD) return null;
  return value;
}

function validateItem(raw, index, errors) {
  const label = `Item ${index + 1}`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push(`${label} is invalid.`);
    return null;
  }
  const name = cleanText(raw.name, FUEL_LIMITS.MAX_NAME_LEN);
  if (!name) errors.push(`${label} needs a name.`);
  return {
    name,
    quantity: optionalAmount(raw, "quantity", FUEL_LIMITS.MAX_QUANTITY, errors, `${label} quantity`),
    unit: cleanText(raw.unit, FUEL_LIMITS.MAX_UNIT_LEN) || null,
    grams: optionalAmount(raw, "grams", FUEL_LIMITS.MAX_GRAMS, errors, `${label} grams`),
    calories: requiredAmount(raw, "calories", FUEL_LIMITS.MAX_CALORIES, errors, `${label} calories`),
    carbs_g: requiredAmount(raw, "carbs_g", FUEL_LIMITS.MAX_CARBS_G, errors, `${label} carbohydrate`),
    protein_g: requiredAmount(raw, "protein_g", FUEL_LIMITS.MAX_PROTEIN_G, errors, `${label} protein`),
    fat_g: requiredAmount(raw, "fat_g", FUEL_LIMITS.MAX_FAT_G, errors, `${label} fat`),
    ai_estimated: raw.ai_estimated === true
  };
}

/*
 * Validates the athlete-confirmed meal.
 *
 * Returns { ok: true, value } where value is safe to hand to the
 * fuel_save_meal() database function, or { ok: false, error }.
 *
 * When items are present the meal's totals are RE-DERIVED from the items on
 * the server (sum, rounded to 0.1). A client can therefore never persist a
 * total that disagrees with its own items. Manual meals with no items use
 * the totals as sent, after the same range checks.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateMealPayload(body, { now = new Date() } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Meal details are required." };
  }
  const errors = [];

  const source = MEAL_SOURCES.includes(body.source) ? body.source : null;
  if (!source) errors.push("Meal source is invalid.");

  const mealType = body.meal_type == null || body.meal_type === ""
    ? null
    : (MEAL_TYPES.includes(body.meal_type) ? body.meal_type : undefined);
  if (mealType === undefined) errors.push("Meal type is invalid.");

  const localDate = validateLocalDate(body.local_date, now);
  if (!localDate) errors.push("Meal date is invalid.");

  const mealName = cleanText(body.meal_name, FUEL_LIMITS.MAX_NAME_LEN);
  if (!mealName) errors.push("Give the meal a name.");

  const note = cleanText(body.note, FUEL_LIMITS.MAX_NOTE_LEN) || null;

  // Optional idempotency key (client-generated UUID) for new meals.
  let clientId = null;
  if (body.client_id !== undefined && body.client_id !== null && body.client_id !== "") {
    if (typeof body.client_id === "string" && UUID_RE.test(body.client_id)) clientId = body.client_id.toLowerCase();
    else errors.push("Request key is invalid.");
  }

  let items = [];
  if (body.items !== undefined && body.items !== null) {
    if (!Array.isArray(body.items)) {
      errors.push("Items must be a list.");
    } else if (body.items.length > FUEL_LIMITS.MAX_ITEMS) {
      errors.push(`A meal can have at most ${FUEL_LIMITS.MAX_ITEMS} items.`);
    } else {
      items = body.items
        .map((raw, i) => validateItem(raw, i, errors))
        .filter(Boolean);
    }
  }

  let totals;
  if (items.length) {
    totals = {
      calories: round1(items.reduce((s, it) => s + it.calories, 0)),
      carbs_g: round1(items.reduce((s, it) => s + it.carbs_g, 0)),
      protein_g: round1(items.reduce((s, it) => s + it.protein_g, 0)),
      fat_g: round1(items.reduce((s, it) => s + it.fat_g, 0))
    };
    if (totals.calories > FUEL_LIMITS.MAX_CALORIES) errors.push("Meal calories are too large.");
    if (totals.carbs_g > FUEL_LIMITS.MAX_CARBS_G) errors.push("Meal carbohydrate is too large.");
    if (totals.protein_g > FUEL_LIMITS.MAX_PROTEIN_G) errors.push("Meal protein is too large.");
    if (totals.fat_g > FUEL_LIMITS.MAX_FAT_G) errors.push("Meal fat is too large.");
  } else {
    totals = {
      calories: requiredAmount(body, "calories", FUEL_LIMITS.MAX_CALORIES, errors, "Calories"),
      carbs_g: requiredAmount(body, "carbs_g", FUEL_LIMITS.MAX_CARBS_G, errors, "Carbohydrate"),
      protein_g: requiredAmount(body, "protein_g", FUEL_LIMITS.MAX_PROTEIN_G, errors, "Protein"),
      fat_g: requiredAmount(body, "fat_g", FUEL_LIMITS.MAX_FAT_G, errors, "Fat")
    };
  }

  if (errors.length) return { ok: false, error: errors[0], errors };

  return {
    ok: true,
    value: {
      meal: {
        local_date: localDate,
        meal_type: mealType,
        meal_name: mealName,
        note,
        source,
        client_id: clientId,
        ...totals
      },
      items
    }
  };
}

/* ───────────────────────────── image checks ─────────────────────────── */

function decodeBase64Strict(data) {
  if (typeof data !== "string") return null;
  if (data.length === 0 || data.length > FUEL_LIMITS.MAX_IMAGE_BASE64_CHARS) return null;
  // Raw base64 only: reject data: URLs and anything that is not base64.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  try {
    return Buffer.from(data, "base64");
  } catch (e) {
    return null;
  }
}

function sniffMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(buf) {
  if (buf.length < 30) return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/*
 * Validates the photo. Error codes are stable strings the client maps to
 * calm, specific messages (and keeps the athlete's note either way).
 *
 * Returns { ok: true, mime, base64, bytes } or { ok: false, code, error }.
 * The decoded bytes are used only for these checks and are then discarded;
 * nothing here writes the image anywhere.
 */
export function validateImagePayload(image) {
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    return { ok: false, code: "IMAGE_REQUIRED", error: "Add a photo to analyze." };
  }
  const declared = typeof image.mime === "string" ? image.mime.toLowerCase() : "";
  const declaredIsHeic = /^image\/(heic|heif)$/.test(declared);
  if (declaredIsHeic) {
    return {
      ok: false,
      code: "UNSUPPORTED_IMAGE_TYPE",
      error: "That photo format isn't supported. Try a JPEG or PNG."
    };
  }
  if (typeof image.data === "string" && image.data.length > FUEL_LIMITS.MAX_IMAGE_BASE64_CHARS) {
    return { ok: false, code: "IMAGE_TOO_LARGE", error: "That photo is too large. Try a smaller one." };
  }
  const buf = decodeBase64Strict(image.data);
  if (!buf || buf.length === 0) {
    return { ok: false, code: "INVALID_IMAGE", error: "We couldn't read that photo." };
  }
  if (buf.length > FUEL_LIMITS.MAX_IMAGE_BYTES) {
    return { ok: false, code: "IMAGE_TOO_LARGE", error: "That photo is too large. Try a smaller one." };
  }
  const sniffed = sniffMime(buf);
  if (!sniffed || !ALLOWED_IMAGE_MIMES.includes(sniffed)) {
    return {
      ok: false,
      code: "UNSUPPORTED_IMAGE_TYPE",
      error: "That photo format isn't supported. Try a JPEG or PNG."
    };
  }
  // The declared MIME is advisory; the bytes win. A mismatch is not fatal
  // (some cameras label JPEGs oddly) as long as the bytes are an allowed type.
  const size = sniffed === "image/png" ? pngSize(buf)
    : sniffed === "image/jpeg" ? jpegSize(buf)
    : webpSize(buf);
  if (!size || !(size.width > 0) || !(size.height > 0)) {
    return { ok: false, code: "INVALID_IMAGE", error: "We couldn't read that photo." };
  }
  const longest = Math.max(size.width, size.height);
  const shortest = Math.min(size.width, size.height);
  if (longest > FUEL_LIMITS.MAX_IMAGE_DIMENSION) {
    return { ok: false, code: "IMAGE_TOO_LARGE", error: "That photo is too large. Try a smaller one." };
  }
  if (shortest < FUEL_LIMITS.MIN_IMAGE_DIMENSION) {
    return { ok: false, code: "INVALID_IMAGE", error: "That photo is too small to analyze." };
  }
  return { ok: true, mime: sniffed, base64: image.data, bytes: buf.length };
}

/* ─────────────────── AI analysis: contract + normalisation ──────────── */

/*
 * OpenAI strict JSON schema. Every property is required (strict mode) and
 * optional values are nullable.
 */
export const FUEL_ANALYSIS_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    is_food_photo: { type: "boolean" },
    meal_name: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          quantity: { type: ["number", "null"] },
          unit: { type: ["string", "null"] },
          estimated_grams: { type: ["number", "null"] },
          calories: { type: "number" },
          carbs_g: { type: "number" },
          protein_g: { type: "number" },
          fat_g: { type: "number" },
          confidence: { type: "string", enum: ["low", "medium", "high"] }
        },
        required: [
          "name", "quantity", "unit", "estimated_grams",
          "calories", "carbs_g", "protein_g", "fat_g", "confidence"
        ]
      }
    },
    assumptions: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } }
  },
  required: ["is_food_photo", "meal_name", "items", "assumptions", "uncertainties"]
});

// Photo estimates should not look more exact than they are.
export function roundEstimateCalories(n) {
  if (n < 100) return Math.round(n / 5) * 5;
  return Math.round(n / 10) * 10;
}
export function roundEstimateGrams(n) {
  if (n < 100) return Math.round(n / 5) * 5;
  return Math.round(n / 10) * 10;
}
export function roundEstimateMacro(n) {
  return Math.round(n);
}

function statements(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string") return null;
    const text = cleanText(entry, FUEL_LIMITS.MAX_STATEMENT_LEN);
    if (text) out.push(text);
    if (out.length >= FUEL_LIMITS.MAX_STATEMENTS) break;
  }
  return out;
}

/*
 * Validates + rounds the model's parsed JSON. Returns the athlete-facing
 * suggestion, or null when the output is malformed (the endpoint then fails
 * safely with ANALYSIS_INVALID — nothing is guessed or patched up).
 *
 * `totals` is always the sum of the rounded items so the review screen and
 * the numbers stored on "Log meal" can never disagree.
 */
export function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.is_food_photo !== "boolean") return null;
  if (!Array.isArray(raw.items)) return null;
  const assumptions = statements(raw.assumptions);
  const uncertainties = statements(raw.uncertainties);
  if (!assumptions || !uncertainties) return null;

  if (!raw.is_food_photo || raw.items.length === 0) {
    return {
      is_food_photo: false,
      meal_name: "",
      items: [],
      totals: { calories: 0, carbs_g: 0, protein_g: 0, fat_g: 0 },
      assumptions,
      uncertainties
    };
  }
  if (raw.items.length > FUEL_LIMITS.MAX_AI_ITEMS) return null;

  const items = [];
  for (const item of raw.items) {
    if (!item || typeof item !== "object") return null;
    const name = cleanText(item.name, FUEL_LIMITS.MAX_NAME_LEN);
    if (!name) return null;
    const calories = toFiniteNumber(item.calories);
    const carbs = toFiniteNumber(item.carbs_g);
    const protein = toFiniteNumber(item.protein_g);
    const fat = toFiniteNumber(item.fat_g);
    if ([calories, carbs, protein, fat].some(v => v === null || v < 0)) return null;
    if (calories > FUEL_LIMITS.MAX_CALORIES || carbs > FUEL_LIMITS.MAX_CARBS_G ||
        protein > FUEL_LIMITS.MAX_PROTEIN_G || fat > FUEL_LIMITS.MAX_FAT_G) return null;

    const quantityRaw = item.quantity === null || item.quantity === undefined ? null : toFiniteNumber(item.quantity);
    const gramsRaw = item.estimated_grams === null || item.estimated_grams === undefined
      ? null : toFiniteNumber(item.estimated_grams);
    if (item.quantity != null && quantityRaw === null) return null;
    if (item.estimated_grams != null && gramsRaw === null) return null;
    if ((quantityRaw !== null && (quantityRaw < 0 || quantityRaw > FUEL_LIMITS.MAX_QUANTITY)) ||
        (gramsRaw !== null && (gramsRaw < 0 || gramsRaw > FUEL_LIMITS.MAX_GRAMS))) return null;

    items.push({
      name,
      quantity: quantityRaw === null ? null : Math.round(quantityRaw * 100) / 100,
      unit: cleanText(item.unit, FUEL_LIMITS.MAX_UNIT_LEN) || null,
      estimated_grams: gramsRaw === null ? null : roundEstimateGrams(gramsRaw),
      calories: roundEstimateCalories(calories),
      carbs_g: roundEstimateMacro(carbs),
      protein_g: roundEstimateMacro(protein),
      fat_g: roundEstimateMacro(fat),
      confidence: CONFIDENCE.includes(item.confidence) ? item.confidence : "low"
    });
  }

  const totals = {
    calories: items.reduce((s, it) => s + it.calories, 0),
    carbs_g: items.reduce((s, it) => s + it.carbs_g, 0),
    protein_g: items.reduce((s, it) => s + it.protein_g, 0),
    fat_g: items.reduce((s, it) => s + it.fat_g, 0)
  };

  return {
    is_food_photo: true,
    meal_name: cleanText(raw.meal_name, FUEL_LIMITS.MAX_NAME_LEN),
    items,
    totals,
    assumptions,
    uncertainties
  };
}
