/*
 * Store sign-up (Athlevo Plan and Athlevo Coaching): PayMongo Hosted Checkout for
 * the public /programs pages.
 *
 * This is deliberately separate from the Athlevo Pro (in-app) payment path:
 * a store visitor has no Athlevo account, the products and prices differ, and a
 * store payment grants no app entitlement. One paid checkout becomes one row in
 * public.plan_signups (product_id says which offer), written only from the
 * signature-verified PayMongo webhook. The browser is never trusted to say that a
 * payment happened.
 *
 * Each offer has its own product, price, endpoints, reference code and switch.
 * The offer is decided by the endpoint that was called, never by the request body.
 * Starting a checkout is off unless that offer's *_SIGNUP_ENABLED is "true" AND a
 * questionnaire URL is a valid https URL (so nobody can pay and then be shown no
 * next step). Closing it only stops new checkouts: payments already in flight are
 * still recorded by the webhook, and buyers can still open their confirmation.
 *
 * Environment (Athlevo Plan; PLAN_*):
 *   PLAN_SIGNUP_ENABLED          "true" to open sign-up (server-side switch)
 *   PLAN_QUESTIONNAIRE_URL       https link shown after payment (required)
 *   PLAN_SCHEDULE_URL            https call-scheduling link (optional)
 *   PLAN_AGREEMENT_URL           https link to the agreement (optional, shown to the buyer)
 * Environment (Athlevo Coaching; COACHING_*):
 *   COACHING_SIGNUP_ENABLED      "true" to open sign-up (server-side switch)
 *   COACHING_QUESTIONNAIRE_URL   https link shown after payment; when it is not set,
 *                                PLAN_QUESTIONNAIRE_URL is used (same questionnaire)
 *   COACHING_SCHEDULE_URL        https call-scheduling link (optional, no fallback)
 *   COACHING_AGREEMENT_URL       https link to the agreement (optional, no fallback)
 * Partner discount codes (lib/server/partnerCodes.js) need no setting: a buyer may send a code
 * with the checkout request, and the server prices the checkout from that code's row in
 * public.partner_codes. Without a code, the price is the offer's own, exactly as before.
 * Shared:
 *   PLAN_SIGNUP_SITE_URL         override the return origin (default: athlevo.org;
 *                                Vercel preview deployments return to themselves)
 *   PAYMONGO_SECRET_KEY, PAYMONGO_WEBHOOK_SECRET, PAYMONGO_PAYMENT_METHODS
 *                                shared with the Athlevo Pro checkout
 */

import crypto from "node:crypto";
import { configuredPaymentMethods, makePaymongoClient } from "./paymongoClient.js";
import { extractPaidCheckout, isFullRefund } from "./paymongoWebhook.js";
import { checkAnonymousAiRateLimit, rateLimitResponse } from "./rateLimit.js";
import {
  describePartnerPayment, discountedCents, lookupPartnerCode, normalizePartnerCode, validDiscountPercent
} from "./partnerCodes.js";

export const ATHLEVO_PLAN_PRODUCT = Object.freeze({
  id: "ATHLEVO_PLAN_MONTHLY",
  name: "Athlevo Plan",
  priceCents: 199800, // ₱1,998
  currency: "PHP",
  entitlementDays: 30,
  description: "Athlevo Plan — 1 month"
});

export const ATHLEVO_COACHING_PRODUCT = Object.freeze({
  id: "ATHLEVO_COACHING_MONTHLY",
  name: "Athlevo Coaching",
  priceCents: 499800, // ₱4,998
  currency: "PHP",
  entitlementDays: 30,
  description: "Athlevo Coaching — 1 month"
});

export const PLAN_PAGE_PATH = "/programs/athlevo-plan";
export const COACHING_PAGE_PATH = "/programs/athlevo-coaching";
export const PLAN_REFERENCE_PATTERN = /^ATH-PL-[0-9A-F]{8,16}-[0-9A-F]{24}$/;
export const COACHING_REFERENCE_PATTERN = /^ATH-CO-[0-9A-F]{8,16}-[0-9A-F]{24}$/;
/** Either offer's reference. The browser uses this same shape (js/storefront.js). */
export const SIGNUP_REFERENCE_PATTERN = /^ATH-(PL|CO)-[0-9A-F]{8,16}-[0-9A-F]{24}$/;
const DAY_MS = 86400000;

// Everything that differs between offers lives here. `envPrefix` names the switch and
// the next-step links; `scope` names the rate limits (lib/server/rateLimit.js).
const PLAN_OFFER = Object.freeze({
  product: ATHLEVO_PLAN_PRODUCT, pagePath: PLAN_PAGE_PATH, refCode: "PL",
  referencePattern: PLAN_REFERENCE_PATTERN, envPrefix: "PLAN", scope: "plan-signup"
});
const COACHING_OFFER = Object.freeze({
  product: ATHLEVO_COACHING_PRODUCT, pagePath: COACHING_PAGE_PATH, refCode: "CO",
  referencePattern: COACHING_REFERENCE_PATTERN, envPrefix: "COACHING", scope: "coaching-signup"
});
const OFFERS = Object.freeze([PLAN_OFFER, COACHING_OFFER]);

function offerForProduct(product) {
  return OFFERS.find(offer => product && offer.product.id === product.id) || null;
}

/** The server-owned product for a store payment's product tag, or null if it is not one. */
export function signupProductFor(productId) {
  const offer = OFFERS.find(item => item.product.id === productId);
  return offer ? offer.product : null;
}

function send(response, status, payload) {
  if (typeof response.setHeader === "function") response.setHeader("Cache-Control", "no-store");
  return response.status(status).json(payload);
}

function serviceHeaders(key, extra = {}) {
  return {
    apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json",
    "Content-Type": "application/json", ...extra
  };
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch (error) {
    return null;
  }
}

function nextStepsFor(offer, env) {
  const questionnaire = env[`${offer.envPrefix}_QUESTIONNAIRE_URL`];
  const fallback = offer === COACHING_OFFER && !String(questionnaire || "").trim()
    ? env.PLAN_QUESTIONNAIRE_URL
    : questionnaire;
  return {
    questionnaireUrl: httpsUrl(fallback),
    scheduleUrl: httpsUrl(env[`${offer.envPrefix}_SCHEDULE_URL`]),
    agreementUrl: httpsUrl(env[`${offer.envPrefix}_AGREEMENT_URL`])
  };
}

function enabledFor(offer, env) {
  return String(env[`${offer.envPrefix}_SIGNUP_ENABLED`] || "").toLowerCase() === "true" &&
    Boolean(nextStepsFor(offer, env).questionnaireUrl);
}

export function planNextSteps(env = process.env) { return nextStepsFor(PLAN_OFFER, env); }
export function coachingNextSteps(env = process.env) { return nextStepsFor(COACHING_OFFER, env); }

/** The next-step links for a store product id (used by the sign-up emails), or null. */
export function signupNextSteps(productId, env = process.env) {
  const offer = OFFERS.find(item => item.product.id === productId);
  return offer ? nextStepsFor(offer, env) : null;
}

/** Where a buyer reopens their confirmation page for a given reference, or null. */
export function signupConfirmationUrl(productId, referenceNumber, env = process.env) {
  const offer = OFFERS.find(item => item.product.id === productId);
  if (!offer || !offer.referencePattern.test(String(referenceNumber || ""))) return null;
  return `${planSiteUrl(env)}${offer.pagePath}?payment=success&ref=${encodeURIComponent(referenceNumber)}`;
}

/** The server-side switches. Closed unless explicitly opened and fully configured. */
export function planSignupEnabled(env = process.env) { return enabledFor(PLAN_OFFER, env); }
export function coachingSignupEnabled(env = process.env) { return enabledFor(COACHING_OFFER, env); }

export function planSiteUrl(env = process.env) {
  const override = httpsUrl(env.PLAN_SIGNUP_SITE_URL);
  if (override) return override.replace(/\/+$/, "");
  if (env.VERCEL_ENV === "preview" && env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "https://athlevo.org";
}

function newReference(offer, now) {
  return `ATH-${offer.refCode}-${now.toString(16)}-${crypto.randomBytes(12).toString("hex")}`.toUpperCase();
}
export function newPlanReference(now = Date.now()) { return newReference(PLAN_OFFER, now); }
export function newCoachingReference(now = Date.now()) { return newReference(COACHING_OFFER, now); }

function checkoutAttributes(offer, { referenceNumber, siteUrl, paymentMethods, product = offer.product, discount = null }) {
  // A discount is { code, percent, amountCents } already checked against partner_codes. The
  // code and percentage ride on the session's metadata so the webhook can confirm that the
  // amount paid is exactly the discounted price, and nothing else.
  const description = discount ? `${product.description} (${discount.percent}% discount applied)` : product.description;
  const metadata = { athlevo_product: product.id, athlevo_source: "store" };
  if (discount) {
    metadata.partner_code = discount.code;
    metadata.discount_percent = String(discount.percent);
    metadata.list_price_cents = String(product.priceCents);
  }
  return {
    line_items: [{
      name: product.name,
      description,
      amount: discount ? discount.amountCents : product.priceCents,
      currency: product.currency,
      quantity: 1
    }],
    payment_method_types: paymentMethods || configuredPaymentMethods(),
    success_url: `${siteUrl}${offer.pagePath}?payment=success&ref=${encodeURIComponent(referenceNumber)}`,
    cancel_url: `${siteUrl}${offer.pagePath}?payment=cancelled`,
    reference_number: referenceNumber,
    send_email_receipt: true,
    show_description: true,
    show_line_items: true,
    description,
    metadata
  };
}
export function buildPlanCheckoutAttributes(args) { return checkoutAttributes(PLAN_OFFER, args); }
export function buildCoachingCheckoutAttributes(args) { return checkoutAttributes(COACHING_OFFER, args); }

function clientIp(request) {
  const headers = request.headers || {};
  const forwarded = headers["x-forwarded-for"] || headers["x-real-ip"] || "";
  const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
  return first || (request.socket && request.socket.remoteAddress) || "";
}

function clientKey(request, scope) {
  const ip = clientIp(request);
  if (!ip) return `${scope}-unknown`;
  const salt = process.env.OAUTH_STATE_SECRET || "athlevo-plan-signup";
  return crypto.createHash("sha256").update(`${scope}:${ip}:${salt}`).digest("hex").slice(0, 64);
}

function readJsonBody(request) {
  const body = request.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  try { return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "")); }
  catch (error) { return null; }
}

/* POST /api/<offer>-signup/checkout — start a hosted checkout. Every payment property,
   including which offer this is, is owned by the server. The only thing read from the body is
   an optional partner discount `code`, which the server looks up and prices itself; with
   `check: true` it answers what that code would cost and opens no checkout. */
function makeCheckoutHandler(offer) {
  return async function signupCheckoutHandler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return send(response, 405, { error: "Method not allowed." });
    }
    if (!enabledFor(offer, process.env) || !process.env.PAYMONGO_SECRET_KEY) {
      return send(response, 503, { error: "Sign-up is not open yet." });
    }
    const body = readJsonBody(request);
    const rawCode = body && typeof body.code === "string" ? body.code.trim().slice(0, 40) : "";
    const checkOnly = Boolean(body && body.check === true);
    if (checkOnly && !rawCode) return send(response, 400, { error: "invalid_code", message: "Enter a code." });
    const limitScope = checkOnly ? `${offer.scope}-code` : offer.scope;
    const limit = await checkAnonymousAiRateLimit(clientKey(request, limitScope), limitScope);
    if (!limit.allowed) return rateLimitResponse(response, limit);

    let discount = null;
    if (rawCode) {
      const found = await lookupPartnerCode(
        process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, rawCode, offer.product);
      if (!found.ok) {
        return found.reason === "unavailable"
          ? send(response, 503, { error: "codes_unavailable", message: "Discount codes are unavailable right now. Please try again shortly." })
          : send(response, 400, { error: "invalid_code", message: "That code isn't valid." });
      }
      discount = found;
      if (checkOnly) {
        return send(response, 200, {
          valid: true, percent_off: found.percent,
          price_cents: found.amountCents, list_price_cents: offer.product.priceCents
        });
      }
    }

    try {
      const reference = newReference(offer, Date.now());
      const attributes = checkoutAttributes(offer, {
        referenceNumber: reference,
        siteUrl: planSiteUrl(),
        paymentMethods: configuredPaymentMethods(),
        discount
      });
      const session = await makePaymongoClient().createCheckoutSession(attributes);
      return send(response, 200, { checkout_url: session.checkoutUrl });
    } catch (error) {
      console.error(`[${offer.scope}] checkout creation failed:`, error && error.message);
      return send(response, 502, { error: "Checkout could not be started. Please try again." });
    }
  };
}

/* POST /api/<offer>-signup/status  { ref } — has this checkout been paid? Answers
   only from the webhook-written row for this offer, never from the redirect.
   Next-step links are returned only for a paid sign-up and carry no personal data. */
function makeStatusHandler(offer) {
  const statusScope = `${offer.scope}-status`;
  return async function signupStatusHandler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      return send(response, 405, { error: "Method not allowed." });
    }
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return send(response, 503, { error: "Status is unavailable right now." });
    const body = readJsonBody(request);
    const reference = body && typeof body.ref === "string" ? body.ref.trim().toUpperCase() : "";
    if (!offer.referencePattern.test(reference)) return send(response, 400, { error: "Invalid reference." });

    const limit = await checkAnonymousAiRateLimit(clientKey(request, statusScope), statusScope);
    if (!limit.allowed) return rateLimitResponse(response, limit);

    try {
      const result = await fetch(
        `${url}/rest/v1/plan_signups?reference_number=eq.${encodeURIComponent(reference)}` +
        `&product_id=eq.${encodeURIComponent(offer.product.id)}&select=status&limit=1`,
        { headers: serviceHeaders(key) }
      );
      if (!result.ok) throw new Error(`Supabase ${result.status}`);
      const rows = await result.json();
      const row = Array.isArray(rows) ? rows[0] : null;
      if (!row) return send(response, 200, { status: "pending" });
      if (row.status !== "paid") return send(response, 200, { status: row.status });
      const steps = nextStepsFor(offer, process.env);
      return send(response, 200, {
        status: "paid",
        questionnaire_url: steps.questionnaireUrl,
        schedule_url: steps.scheduleUrl,
        agreement_url: steps.agreementUrl
      });
    } catch (error) {
      console.error(`[${offer.scope}] status lookup failed:`, error && error.message);
      return send(response, 502, { error: "Status is unavailable right now." });
    }
  };
}

export const planSignupCheckoutHandler = makeCheckoutHandler(PLAN_OFFER);
export const planSignupStatusHandler = makeStatusHandler(PLAN_OFFER);
export const coachingSignupCheckoutHandler = makeCheckoutHandler(COACHING_OFFER);
export const coachingSignupStatusHandler = makeStatusHandler(COACHING_OFFER);

// ---- Webhook side ---------------------------------------------------------

function text(value, max = 200) {
  const s = String(value == null ? "" : value).trim();
  return s ? s.slice(0, max) : null;
}

/** Contact details PayMongo collected at checkout. Every field is optional. */
export function extractPlanContact(envelope) {
  const attributes = envelope && envelope.resource && envelope.resource.attributes || {};
  const payments = Array.isArray(attributes.payments) ? attributes.payments : [];
  const payment = payments.find(item => item && item.attributes && item.attributes.status === "paid") || payments[0] || {};
  const billing = (payment.attributes && payment.attributes.billing) || attributes.billing || {};
  const email = text(billing.email || attributes.customer_email);
  return {
    name: text(billing.name),
    email: email ? email.toLowerCase() : null,
    phone: text(billing.phone, 40)
  };
}

/** A paid checkout for any store product (Plan or Coaching), or null for every other event. */
export function extractSignupPayment(envelope) {
  const paid = extractPaidCheckout(envelope);
  if (!paid || !signupProductFor(paid.productId)) return null;
  const metadata = envelope.resource && envelope.resource.attributes && envelope.resource.attributes.metadata || {};
  const percent = metadata.discount_percent;
  return {
    ...paid,
    contact: extractPlanContact(envelope),
    // Present only on a checkout the server priced from a partner code (see checkoutAttributes).
    partnerCode: metadata.partner_code ? String(metadata.partner_code).slice(0, 40) : null,
    discountPercent: percent === undefined || percent === null || percent === "" ? null : Number(percent)
  };
}

/** A paid checkout for the Plan product, or null for every other event. */
export function extractPlanPayment(envelope) {
  const paid = extractSignupPayment(envelope);
  return paid && paid.productId === ATHLEVO_PLAN_PRODUCT.id ? paid : null;
}

/** A paid checkout for the Coaching product, or null for every other event. */
export function extractCoachingPayment(envelope) {
  const paid = extractSignupPayment(envelope);
  return paid && paid.productId === ATHLEVO_COACHING_PRODUCT.id ? paid : null;
}

/** Why a store payment must not be recorded, or null. Checked against the server's own product. */
export function validatePlanPayment(details, product = ATHLEVO_PLAN_PRODUCT) {
  if (!details) return "unsupported_event";
  const offer = offerForProduct(product);
  if (!offer) return "wrong_product";
  // The price owed is the offer's own, unless the checkout carries a partner code and a
  // percentage, in which case it is exactly that percentage off. Either half alone is refused.
  let expectedCents = product.priceCents;
  if (details.partnerCode || (details.discountPercent !== null && details.discountPercent !== undefined)) {
    if (!normalizePartnerCode(details.partnerCode) || !validDiscountPercent(details.discountPercent)) return "bad_discount";
    expectedCents = discountedCents(product.priceCents, details.discountPercent);
  }
  if (details.amountCents !== expectedCents) return "wrong_amount";
  if (details.currency !== product.currency) return "wrong_currency";
  if (details.productId !== product.id) return "wrong_product";
  if (!details.checkoutId || !details.paymentId) return "missing_transaction_reference";
  if (!offer.referencePattern.test(String(details.referenceNumber || ""))) return "bad_reference";
  return null;
}

async function rest(url, key, path, { method = "GET", body, prefer } = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: serviceHeaders(key, prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch (error) { data = null; }
  if (!response.ok) {
    const error = new Error(`Supabase ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

// What the row's metadata says. A payment made with a partner code keeps the code and the
// percentage here (and a flag when another email already used the code), and every later
// write of this column (the notification note) passes through here too, so none of it is lost.
function signupMetadata(details, mode, codeEmailMismatch = false) {
  const code = details && details.partnerCode ? normalizePartnerCode(details.partnerCode) : null;
  return {
    webhook_mode: mode, event_id: details && details.eventId,
    ...(code ? { partner_code: code, discount_percent: details.discountPercent } : {}),
    ...(code && codeEmailMismatch ? { code_email_mismatch: true } : {})
  };
}

/** Record a verified paid checkout. Safe to deliver twice: the second is a no-op. */
export async function applyPlanPayment(url, key, details, mode, product = ATHLEVO_PLAN_PRODUCT) {
  // Never record a payment under a product other than the one it was paid for.
  if (!details || details.productId !== product.id) {
    throw new Error("Payment product does not match the product being recorded");
  }
  const paidAt = details.paidAt || new Date().toISOString();
  const paidThrough = new Date(Date.parse(paidAt) + product.entitlementDays * DAY_MS).toISOString();
  const partnerCode = details.partnerCode ? normalizePartnerCode(details.partnerCode) : null;
  const partnerInfo = partnerCode
    ? await describePartnerPayment(url, key, { code: partnerCode, email: details.contact && details.contact.email })
    : null;
  const row = {
    reference_number: details.referenceNumber,
    provider: "paymongo",
    provider_checkout_id: details.checkoutId,
    provider_payment_id: details.paymentId,
    status: "paid",
    product_id: product.id,
    amount_cents: details.amountCents,
    currency: details.currency,
    entitlement_days: product.entitlementDays,
    payment_method_type: text(details.paymentMethodType, 40),
    customer_name: details.contact && details.contact.name || null,
    customer_email: details.contact && details.contact.email || null,
    customer_phone: details.contact && details.contact.phone || null,
    livemode: details.livemode === true,
    paid_at: paidAt,
    paid_through: paidThrough,
    metadata: signupMetadata(details, mode, Boolean(partnerInfo && partnerInfo.mismatch))
  };
  // A payment made with a partner code also says so in metadata, so it is never lost even if the
  // extra columns below are missing. Without a code, the row is exactly what it always was.
  let extendedRow = null;
  if (partnerCode) {
    extendedRow = {
      ...row, partner_code: partnerCode, partner: partnerInfo && partnerInfo.partner || null,
      list_price_cents: product.priceCents, discount_percent: details.discountPercent
    };
  }
  const post = body => rest(url, key, "plan_signups?on_conflict=reference_number", {
    method: "POST", body, prefer: "resolution=ignore-duplicates,return=representation"
  });
  try {
    let inserted;
    try {
      inserted = await post(extendedRow || row);
    } catch (error) {
      // Columns not added yet (the partner-codes migration was not run): keep the payment.
      if (!extendedRow || !error || error.status !== 400) throw error;
      inserted = await post(row);
    }
    const applied = Array.isArray(inserted) && inserted.length > 0;
    return {
      applied, duplicate: !applied, paid_through: applied ? paidThrough : undefined,
      ...(partnerCode ? { partner: {
        code: partnerCode, label: partnerInfo && partnerInfo.partner || null,
        percent: details.discountPercent, mismatch: Boolean(partnerInfo && partnerInfo.mismatch)
      } } : {})
    };
  } catch (error) {
    if (error && error.status === 409) return { applied: false, duplicate: true };
    throw error;
  }
}

/**
 * Note on the sign-up row how its emails went (buyer and owner: "sent", "failed", "no_email",
 * "not_configured", ...), so a missing email can be diagnosed from the table. Best effort:
 * it never throws, and the payment is already recorded either way.
 */
export async function recordSignupNotifications(url, key, details, mode, outcome, partner = null) {
  try {
    if (!details || !details.referenceNumber || !outcome) return false;
    await rest(url, key, `plan_signups?reference_number=eq.${encodeURIComponent(details.referenceNumber)}`, {
      method: "PATCH",
      body: { metadata: { ...signupMetadata(details, mode, Boolean(partner && partner.mismatch)), notifications: outcome } }
    });
    return true;
  } catch (error) {
    console.error("[plan-signup] could not note notification outcome:", error && error.status);
    return false;
  }
}

/** Mark a refunded store payment (Plan or Coaching). { matched: false } means it is not one. */
export async function applyPlanRefund(url, key, refund, mode) {
  if (!refund || !refund.paymentId) return { matched: false };
  let rows;
  try {
    rows = await rest(url, key,
      "plan_signups?provider=eq.paymongo" +
      `&provider_payment_id=eq.${encodeURIComponent(refund.paymentId)}` +
      "&select=id,status,amount_cents&limit=1");
  } catch (error) {
    // The table does not exist until the migration is run, so before then no refund
    // can be a store refund. Any other failure is real and is retried by PayMongo.
    if (error && error.status === 404) return { matched: false };
    throw error;
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { matched: false };
  if (row.status === "refunded") return { matched: true, applied: false, duplicate: true };

  let full = isFullRefund(refund, row.amount_cents, null);
  if (!full) {
    const paymongo = makePaymongoClient();
    if (!paymongo.isConfigured()) throw new Error("PayMongo payment lookup unavailable");
    full = isFullRefund(refund, row.amount_cents, await paymongo.getPayment(refund.paymentId));
  }
  if (!full) return { matched: true, applied: false, ignored: true, reason: "partial_or_pending_refund" };

  await rest(url, key, `plan_signups?id=eq.${encodeURIComponent(row.id)}&status=eq.paid`, {
    method: "PATCH",
    body: { status: "refunded", refunded_at: refund.refundedAt || new Date().toISOString() }
  });
  return { matched: true, applied: true };
}

export const PLAN_SIGNUP_VERSION = "store-signup-v2";
