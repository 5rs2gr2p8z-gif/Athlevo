/* Shared handler behind /api/paymongo/webhook and the consolidated webhook. */

import { ATHLEVO_PERFORMANCE_PRODUCT, makePaymongoClient } from "./paymongoClient.js";
import {
  extractPaidCheckout, extractPaymongoEvent, extractRefund, isFullRefund,
  parsePaymongoEvent, validatePaidCheckout, verifyPaymongoSignature
} from "./paymongoWebhook.js";
import { captureServerEvent } from "./productAnalytics.js";

function send(response, status, payload) { return response.status(status).json(payload); }
function headers(key) {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" };
}
function readRawBody(request) {
  return new Promise((resolve, reject) => {
    if (Buffer.isBuffer(request.body)) return resolve(request.body);
    if (typeof request.body === "string") return resolve(Buffer.from(request.body));
    const chunks = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
async function rest(url, key, path, { method = "GET", body } = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    method, headers: headers(key),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
  if (!response.ok) {
    const error = new Error(`Supabase ${response.status}`);
    error.status = response.status; error.body = data; throw error;
  }
  return data;
}
async function knownCheckout(url, key, details) {
  const rows = await rest(url, key,
    "payment_transactions?provider=eq.paymongo" +
    `&provider_checkout_id=eq.${encodeURIComponent(details.checkoutId)}` +
    `&reference_number=eq.${encodeURIComponent(details.referenceNumber)}` +
    "&select=*&limit=1");
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function byPayment(url, key, paymentId) {
  const rows = await rest(url, key,
    "payment_transactions?provider=eq.paymongo" +
    `&provider_payment_id=eq.${encodeURIComponent(paymentId)}` +
    "&select=*&limit=1");
  return Array.isArray(rows) ? rows[0] || null : null;
}
async function authUserExists(url, key, userId) {
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { headers: headers(key) });
  if (response.status !== 404 && !response.ok) throw new Error("Auth user lookup unavailable");
  return response.ok;
}
async function applyPaid(url, key, details, mode) {
  const tx = await knownCheckout(url, key, details);
  if (!tx || tx.user_id !== details.userId ||
      tx.amount_cents !== ATHLEVO_PERFORMANCE_PRODUCT.priceCents ||
      tx.currency !== ATHLEVO_PERFORMANCE_PRODUCT.currency ||
      tx.product_id !== ATHLEVO_PERFORMANCE_PRODUCT.id ||
      tx.entitlement_days !== ATHLEVO_PERFORMANCE_PRODUCT.entitlementDays ||
      Boolean(tx.metadata && tx.metadata.livemode) !== details.livemode) {
    const error = new Error("Known checkout validation failed"); error.status = 400; throw error;
  }
  if (!(await authUserExists(url, key, details.userId))) {
    const error = new Error("Athlevo user mapping no longer exists"); error.status = 400; throw error;
  }
  return rest(url, key, "rpc/apply_paymongo_payment", { method: "POST", body: {
    p_event_id: details.eventId, p_user_id: details.userId,
    p_checkout_id: details.checkoutId, p_payment_id: details.paymentId,
    p_reference_number: details.referenceNumber, p_amount_cents: details.amountCents,
    p_currency: details.currency, p_payment_method_type: details.paymentMethodType,
    p_paid_at: details.paidAt, p_product_id: details.productId,
    p_entitlement_days: ATHLEVO_PERFORMANCE_PRODUCT.entitlementDays,
    p_metadata: { webhook_mode: mode }
  }});
}
async function applyRefund(url, key, refund, mode) {
  if (!refund.paymentId) return { ignored: true, reason: "missing_payment" };
  const tx = await byPayment(url, key, refund.paymentId);
  if (!tx) return { ignored: true, reason: "unknown_payment" };
  let fullRefund = isFullRefund(refund, tx.amount_cents, null);
  if (!fullRefund) {
    const paymongo = makePaymongoClient();
    if (!paymongo.isConfigured()) throw new Error("PayMongo payment lookup unavailable");
    const payment = await paymongo.getPayment(refund.paymentId);
    fullRefund = isFullRefund(refund, tx.amount_cents, payment);
  }
  if (!fullRefund) {
    return { ignored: true, reason: "partial_or_pending_refund" };
  }
  return rest(url, key, "rpc/apply_paymongo_refund", { method: "POST", body: {
    p_event_id: refund.eventId, p_payment_id: refund.paymentId,
    p_refunded_at: refund.refundedAt,
    p_metadata: { webhook_mode: mode, refund_event_type: refund.eventType }
  }});
}

export default async function paymongoWebhookHandler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST"); return send(response, 405, { error: "Method not allowed." });
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = process.env.PAYMONGO_WEBHOOK_SECRET;
  if (!url || !key || !secret) return send(response, 500, { error: "Server not configured." });

  let rawBody;
  try { rawBody = await readRawBody(request); }
  catch (error) { return send(response, 400, { error: "Bad body." }); }
  const verified = verifyPaymongoSignature(rawBody, request.headers["paymongo-signature"], secret);
  if (!verified.valid) return send(response, 401, { error: "Invalid signature." });

  // Never parse or trust the payload before raw-body HMAC verification.
  const event = parsePaymongoEvent(rawBody);
  const envelope = event && extractPaymongoEvent(event, rawBody);
  if (!envelope) return send(response, 400, { error: "Unparseable event." });
  if ((verified.mode === "live") !== (envelope.livemode === true)) {
    return send(response, 401, { error: "Webhook mode mismatch." });
  }

  try {
    const paid = extractPaidCheckout(envelope);
    if (paid) {
      if (validatePaidCheckout(paid)) return send(response, 400, { error: "Payment validation failed." });
      const result = await applyPaid(url, key, paid, verified.mode);
      if (result && result.applied) {
        await captureServerEvent(paid.userId, "subscription_activated", { source: "paymongo_webhook" });
      }
      return send(response, 200, { ok: true, result });
    }
    const refund = extractRefund(envelope);
    if (refund) return send(response, 200, { ok: true, result: await applyRefund(url, key, refund, verified.mode) });
    return send(response, 200, { ok: true, ignored: true });
  } catch (error) {
    console.error("[paymongo] webhook processing failed:", error && error.message);
    return send(response, error && error.status === 400 ? 400 : 500, { error: "Processing failed." });
  }
}
