/*
 * Partner discount codes for the public sign-up (Athlevo Plan and Athlevo Coaching).
 *
 * A code is unique to one runner. It takes a fixed percentage off the server-owned price
 * of a store offer, on every payment that runner makes with it (renewals included). The
 * discount is worked out here, on the server, from the code's own row in
 * public.partner_codes: the browser only ever sends the code text and is never trusted
 * with an amount. The partner label on a code is internal. It is never sent to the
 * browser or to the buyer, and nothing on the public site names a partner.
 *
 * Every payment made with a code is recorded on its public.plan_signups row (partner_code,
 * partner, list_price_cents, discount_percent), which is how a partner's share is worked out.
 * A code is also remembered against the first email that paid with it. A later payment from
 * a different email is still accepted (the buyer already paid), but it is flagged on the row
 * and in the owner's alert, so a shared code is noticed.
 *
 * Codes are created with scripts/generate-partner-codes.mjs; see docs/plan-signup.md.
 */

// No 0/1/I/L/O, so a code read aloud or typed from a screenshot is hard to get wrong.
export const PARTNER_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const PARTNER_CODE_LENGTH = 8;
export const MAX_DISCOUNT_PERCENT = 50;
const CODE_PATTERN = new RegExp(`^[${PARTNER_CODE_ALPHABET}]{${PARTNER_CODE_LENGTH}}$`);

/** The canonical code (upper case, no spaces or hyphens), or null when it cannot be a code. */
export function normalizePartnerCode(value) {
  const code = String(value == null ? "" : value).toUpperCase().replace(/[\s-]+/g, "");
  return CODE_PATTERN.test(code) ? code : null;
}

/** "ABCD-EFGH", the way a code is shown to people. */
export function formatPartnerCode(code) {
  const normalized = normalizePartnerCode(code);
  return normalized ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : "";
}

export function validDiscountPercent(percent) {
  return Number.isInteger(percent) && percent >= 1 && percent <= MAX_DISCOUNT_PERCENT;
}

/** The discounted price in centavos, rounded half up. Integer arithmetic only. */
export function discountedCents(listCents, percent) {
  return Math.floor((listCents * (100 - percent) + 50) / 100);
}

function serviceHeaders(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" };
}

async function getRows(url, key, path) {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: serviceHeaders(key) });
  if (!response.ok) {
    const error = new Error(`Supabase ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows : [];
}

// A code with no product list works on the offers sold with discount codes: Athlevo Plan and
// Athlevo Coaching. Any other offer (Elite Coaching) takes a code only when the row names it in
// product_ids, so opening a new offer never quietly gives it a discount.
export const DEFAULT_CODE_PRODUCT_IDS = Object.freeze(["ATHLEVO_PLAN_MONTHLY", "ATHLEVO_COACHING_MONTHLY"]);

/**
 * Look a code up for a product. Resolves to
 *   { ok: true, code, partner, percent, listCents, amountCents }
 * or { ok: false, reason: "invalid" | "unavailable" }. "invalid" covers a code that does not
 * exist, is switched off, has expired, or is not for this product: the buyer is told only
 * that the code is not valid. "unavailable" means the lookup itself failed.
 */
export async function lookupPartnerCode(url, key, rawCode, product, now = Date.now()) {
  const code = normalizePartnerCode(rawCode);
  if (!code) return { ok: false, reason: "invalid" };
  if (!url || !key) return { ok: false, reason: "unavailable" };
  let row;
  try {
    const rows = await getRows(url, key,
      `partner_codes?code=eq.${encodeURIComponent(code)}` +
      "&select=code,partner,percent_off,product_ids,active,expires_at&limit=1");
    row = rows[0];
  } catch (error) {
    console.error("[partner-codes] lookup failed:", error && error.status);
    return { ok: false, reason: "unavailable" };
  }
  if (!row || row.active !== true) return { ok: false, reason: "invalid" };
  if (row.expires_at && !(Date.parse(row.expires_at) > now)) return { ok: false, reason: "invalid" };
  const listed = Array.isArray(row.product_ids) ? row.product_ids : [];
  const allowed = listed.length ? listed : DEFAULT_CODE_PRODUCT_IDS;
  if (!allowed.includes(product.id)) return { ok: false, reason: "invalid" };
  const percent = Number(row.percent_off);
  if (!validDiscountPercent(percent)) return { ok: false, reason: "invalid" };
  return {
    ok: true, code, partner: String(row.partner || ""), percent,
    listCents: product.priceCents, amountCents: discountedCents(product.priceCents, percent)
  };
}

/**
 * For a payment made with a code: the code's internal partner label, and whether an EARLIER
 * payment with the same code came from a different email. Best effort: it never throws, and a
 * failure just leaves the label empty and no flag.
 */
export async function describePartnerPayment(url, key, { code, email }) {
  const out = { partner: null, mismatch: false };
  const canonical = normalizePartnerCode(code);
  if (!canonical || !url || !key) return out;
  try {
    const rows = await getRows(url, key,
      `partner_codes?code=eq.${encodeURIComponent(canonical)}&select=partner&limit=1`);
    out.partner = rows[0] && rows[0].partner ? String(rows[0].partner) : null;
  } catch (error) { /* label stays empty */ }
  try {
    const first = (await getRows(url, key,
      `plan_signups?partner_code=eq.${encodeURIComponent(canonical)}` +
      "&select=customer_email,paid_at&order=paid_at.asc&limit=1"))[0];
    const earlier = first && first.customer_email ? String(first.customer_email).toLowerCase() : null;
    const current = email ? String(email).toLowerCase() : null;
    out.mismatch = Boolean(earlier && current && earlier !== current);
  } catch (error) { /* no flag */ }
  return out;
}
