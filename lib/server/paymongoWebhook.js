/* Pure PayMongo webhook verification, parsing, and entitlement helpers. */

import crypto from "node:crypto";
import { ATHLEVO_PERFORMANCE_PRODUCT } from "./paymongoClient.js";

const SIGNATURE_TOLERANCE_SECONDS = 300;

function safeHexEqual(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (error) { return false; }
}

function signatureParts(header) {
  return String(header || "").split(",").reduce((parts, item) => {
    const index = item.indexOf("=");
    if (index > 0) parts[item.slice(0, index).trim()] = item.slice(index + 1).trim();
    return parts;
  }, {});
}

export function verifyPaymongoSignature(
  rawBody,
  signatureHeader,
  secret,
  nowMs = Date.now()
) {
  if (rawBody == null || !signatureHeader || !secret) return { valid: false, mode: null };
  const parts = signatureParts(signatureHeader);
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return { valid: false, mode: null };
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { valid: false, mode: null };
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody);
  const expected = crypto.createHmac("sha256", String(secret))
    .update(`${parts.t}.${body}`)
    .digest("hex");
  if (parts.te && safeHexEqual(parts.te, expected)) return { valid: true, mode: "test" };
  if (parts.li && safeHexEqual(parts.li, expected)) return { valid: true, mode: "live" };
  return { valid: false, mode: null };
}

export function parsePaymongoEvent(rawBody) {
  try {
    return JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
  } catch (error) {
    return null;
  }
}

function isoFromTimestamp(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizedEnvelope(event, rawBody) {
  const data = event && event.data || {};
  const legacyAttributes = data.attributes || {};
  const type = data.type === "event"
    ? legacyAttributes.type
    : data.type || event && event.type;
  const resource = data.type === "event"
    ? legacyAttributes.data
    : data.data || data.resource_data || null;
  const eventId = data.id || event && event.id ||
    `evt_body_${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 40)}`;
  const livemode = data.type === "event" ? legacyAttributes.livemode : data.livemode;
  const createdAt = data.type === "event" ? legacyAttributes.created_at : data.created_at;
  return { type: String(type || ""), resource, eventId, livemode, createdAt };
}

export function extractPaymongoEvent(event, rawBody = "") {
  if (!event || typeof event !== "object") return null;
  return normalizedEnvelope(event, Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)));
}

export function extractPaidCheckout(envelope) {
  if (!envelope || envelope.type !== "checkout_session.payment.paid") return null;
  const session = envelope.resource || {};
  const attributes = session.attributes || {};
  const payments = Array.isArray(attributes.payments) ? attributes.payments : [];
  const payment = payments.find(item => item && item.attributes && item.attributes.status === "paid") || payments[0] || {};
  const paymentAttributes = payment.attributes || {};
  const metadata = attributes.metadata || {};
  return {
    eventId: envelope.eventId,
    checkoutId: session.id || null,
    referenceNumber: attributes.reference_number || null,
    paymentId: payment.id || null,
    amountCents: Number(paymentAttributes.amount),
    currency: String(paymentAttributes.currency || "").toUpperCase(),
    paymentMethodType: paymentAttributes.source && paymentAttributes.source.type || null,
    paidAt: isoFromTimestamp(paymentAttributes.paid_at || envelope.createdAt) || new Date().toISOString(),
    userId: metadata.athlevo_user_id || null,
    productId: metadata.athlevo_product || null,
    livemode: envelope.livemode === true
  };
}

export function validatePaidCheckout(details, product = ATHLEVO_PERFORMANCE_PRODUCT) {
  if (!details) return "unsupported_event";
  if (details.amountCents !== product.priceCents) return "wrong_amount";
  if (details.currency !== product.currency) return "wrong_currency";
  if (details.productId !== product.id) return "wrong_product";
  if (!details.userId) return "missing_user";
  if (!details.checkoutId || !details.referenceNumber || !details.paymentId) return "missing_transaction_reference";
  return null;
}

export function extractRefund(envelope) {
  if (!envelope || ![
    "payment.refunded", "payment.refund.updated", "refund.succeeded"
  ].includes(envelope.type)) return null;
  const resource = envelope.resource || {};
  const attributes = resource.attributes || {};
  const refunds = Array.isArray(attributes.refunds) ? attributes.refunds : [];
  const refundedTotal = refunds.reduce((total, refund) => {
    const refundAttributes = refund && refund.attributes || refund || {};
    return /succeed|refund/i.test(String(refundAttributes.status || "succeeded"))
      ? total + (Number(refundAttributes.amount) || 0)
      : total;
  }, 0);
  return {
    eventId: envelope.eventId,
    paymentId: resource.type === "payment" || /^pay_/.test(resource.id || "")
      ? resource.id
      : attributes.payment_id || null,
    amountCents: Number(attributes.amount) || null,
    refundedTotalCents: refundedTotal || null,
    status: String(attributes.status || "").toLowerCase(),
    refundedAt: isoFromTimestamp(attributes.updated_at || attributes.created_at || envelope.createdAt) || new Date().toISOString(),
    eventType: envelope.type
  };
}

export function isFullRefund(refund, transactionAmount, authoritativePayment) {
  if (!refund || !transactionAmount) return false;
  if (refund.eventType === "payment.refunded") return true;
  if (refund.refundedTotalCents >= transactionAmount) return true;
  const attributes = authoritativePayment && authoritativePayment.attributes || {};
  const total = (Array.isArray(attributes.refunds) ? attributes.refunds : []).reduce((sum, item) => {
    const attrs = item && item.attributes || item || {};
    return /succeed|refund/i.test(String(attrs.status || "succeeded"))
      ? sum + (Number(attrs.amount) || 0)
      : sum;
  }, 0);
  return total >= transactionAmount ||
    (refund.status === "succeeded" && refund.amountCents >= transactionAmount);
}

export function computePaidUntil({ nowMs, paidUntil, currentPeriodEnd, days = 30 }) {
  const candidates = [nowMs, Date.parse(paidUntil), Date.parse(currentPeriodEnd)]
    .filter(Number.isFinite);
  return new Date(Math.max(...candidates) + days * 86400000).toISOString();
}

export function recomputePaymongoPaidUntil(transactions) {
  let end = null;
  (transactions || []).filter(tx => tx && tx.status === "paid")
    .sort((a, b) => Date.parse(a.paid_at || a.created_at) - Date.parse(b.paid_at || b.created_at))
    .forEach(tx => {
      const paidAt = Date.parse(tx.paid_at || tx.created_at);
      const whopBase = Date.parse(tx.metadata && tx.metadata.whop_period_end_at_payment);
      const base = Math.max(end || 0, Number.isFinite(paidAt) ? paidAt : 0, Number.isFinite(whopBase) ? whopBase : 0);
      end = base + (Number(tx.entitlement_days) || 0) * 86400000;
    });
  return end ? new Date(end).toISOString() : null;
}

export const PAYMONGO_WEBHOOK_VERSION = "paymongo-webhook-v1";
