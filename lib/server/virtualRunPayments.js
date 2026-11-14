/*
 * Sub-1 10k Challenge payments: the webhook side.
 *
 * A registration becomes "paid" ONLY here, from a signature-verified PayMongo event
 * (lib/server/paymongoWebhookEndpoint.js verifies the signature before calling anything in this file).
 * The browser, the success redirect and the status screen can never mark anything paid.
 *
 * What is checked before a payment is recorded:
 *   - the checkout carries this event's tag (athlevo_source "virtual-run") and a registration reference
 *   - a registration with exactly that reference exists, and its ID matches the checkout's tag
 *   - the amount and currency PayMongo took equal the amount the SERVER saved on the registration
 *     (the server priced it from content/virtualRun.mjs when it opened the checkout)
 *   - the product is the one saved on the registration
 *
 * Repeated callbacks are safe: the update only touches a registration that is not yet paid, so the
 * second delivery changes nothing and sends no second email. A late "paid" event never undoes a
 * refund. A second, different payment for an already-paid registration is acknowledged (so PayMongo
 * stops retrying) and reported to the owner, so it can be refunded by hand.
 */

import * as content from "../../content/virtualRun.mjs";
import { extractPaidCheckout, isFullRefund } from "./paymongoWebhook.js";
import { makePaymongoClient } from "./paymongoClient.js";
import { alertRecipients, sendEmail, validEmail } from "./signupNotifications.js";
import { PAYABLE_STATUSES, REFERENCE_PATTERN, VIRTUAL_RUN_TABLE, nextStepLinks, packageFrom } from "./virtualRun.js";

const DB_TIMEOUT_MS = 6000;
const SOURCE_TAG = "virtual-run";

function serviceHeaders(key, extra = {}) {
  return {
    apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json", ...extra
  };
}

async function rest(url, key, path, { method = "GET", body, prefer } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(`${url}/rest/v1/${path}`, {
      method, signal: controller.signal, headers: serviceHeaders(key, prefer ? { Prefer: prefer } : {}),
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
  } finally {
    clearTimeout(timer);
  }
}

function text(value, max = 200) {
  const s = String(value == null ? "" : value).trim();
  return s ? s.slice(0, max) : null;
}

/* ---------------------------------------------------------------- reading the event */

/**
 * A paid checkout for this event, or null for every other event. A checkout tagged as this event is
 * returned even when its product is unknown, so validation can refuse it loudly instead of it
 * slipping through as some other kind of payment.
 */
export function extractVirtualRunPayment(envelope) {
  const paid = extractPaidCheckout(envelope);
  if (!paid) return null;
  const metadata = envelope.resource && envelope.resource.attributes && envelope.resource.attributes.metadata || {};
  if (metadata.athlevo_source !== SOURCE_TAG) return null;
  return {
    ...paid,
    registrationId: text(metadata.athlevo_registration, 40),
    paymongoEventId: paid.eventId,
    athlevoEvent: text(metadata.athlevo_event, 80)
  };
}

/** Why a payment must not be recorded against this registration row, or null. */
export function validateVirtualRunPayment(details, row) {
  if (!details) return "unsupported_event";
  if (!row) return "unknown_registration";
  if (!REFERENCE_PATTERN.test(String(details.referenceNumber || ""))) return "bad_reference";
  if (!details.registrationId || details.registrationId !== row.registration_id) return "registration_mismatch";
  if (details.athlevoEvent !== row.event) return "event_mismatch";
  if (details.productId !== row.product_id) return "wrong_product";
  if (details.amountCents !== row.amount_cents) return "wrong_amount";
  if (details.currency !== row.currency) return "wrong_currency";
  if (!details.checkoutId || !details.paymentId) return "missing_transaction_reference";
  if (row.provider_checkout_id && row.provider_checkout_id !== details.checkoutId) return "wrong_checkout";
  return null;
}

/* ---------------------------------------------------------------- recording it */

async function loadRegistration(url, key, referenceNumber) {
  if (!REFERENCE_PATTERN.test(String(referenceNumber || ""))) return null;
  const rows = await rest(url, key, `${VIRTUAL_RUN_TABLE}?reference_number=eq.${encodeURIComponent(referenceNumber)}&select=*&limit=1`);
  return Array.isArray(rows) ? rows[0] || null : null;
}

/**
 * Looks up the registration a paid event is for, so the caller can validate it before anything is
 * written. Returns the row, or null (no such registration, or the table is not there yet).
 */
export async function findRegistrationForPayment(url, key, details) {
  try {
    return await loadRegistration(url, key, details && details.referenceNumber);
  } catch (error) {
    if (error && error.status === 404) return null;
    throw error;
  }
}

/**
 * Record a verified paid checkout. Safe to deliver twice.
 * Returns { applied, duplicate, row, extraPayment }:
 *   applied        this delivery is the one that marked the registration paid
 *   duplicate      it was already paid by this same payment (a repeated callback): nothing changed
 *   extraPayment   it was already paid by a DIFFERENT payment: record nothing, tell the owner
 *   ignored        the registration was refunded: a late paid event never reverses that
 */
export async function applyVirtualRunPayment(url, key, details, mode, row) {
  if (!row) throw new Error("no registration to record the payment against");
  if (row.payment_status === "refunded") return { applied: false, ignored: true, row };
  if (row.payment_status === "paid") {
    if (row.provider_payment_id === details.paymentId) return { applied: false, duplicate: true, row };
    return { applied: false, extraPayment: true, row };
  }
  const paidAt = details.paidAt || new Date().toISOString();
  const patch = {
    payment_status: "paid",
    paid_at: paidAt,
    provider_checkout_id: details.checkoutId,
    provider_payment_id: details.paymentId,
    payment_method_type: text(details.paymentMethodType, 40),
    livemode: details.livemode === true,
    updated_at: new Date().toISOString(),
    metadata: { ...(row.metadata || {}), webhook_mode: mode, paymongo_event_id: details.paymongoEventId }
  };
  // Only a registration that is not yet paid can be updated, so of two simultaneous deliveries exactly
  // one gets a row back. The other changes nothing and is treated as a repeat.
  const updated = await rest(url, key,
    `${VIRTUAL_RUN_TABLE}?reference_number=eq.${encodeURIComponent(row.reference_number)}` +
    `&payment_status=in.(${PAYABLE_STATUSES.join(",")})`,
    { method: "PATCH", body: patch, prefer: "return=representation" });
  const winner = Array.isArray(updated) ? updated[0] : null;
  if (!winner) {
    const current = await loadRegistration(url, key, row.reference_number);
    if (current && current.payment_status === "paid" && current.provider_payment_id !== details.paymentId) {
      return { applied: false, extraPayment: true, row: current };
    }
    return { applied: false, duplicate: true, row: current || row };
  }
  return { applied: true, duplicate: false, row: winner };
}

/** Mark a refunded registration. { matched: false } means the payment is not one of ours. */
export async function applyVirtualRunRefund(url, key, refund, mode) {
  if (!refund || !refund.paymentId) return { matched: false };
  let rows;
  try {
    rows = await rest(url, key,
      `${VIRTUAL_RUN_TABLE}?provider_payment_id=eq.${encodeURIComponent(refund.paymentId)}&select=id,payment_status,amount_cents&limit=1`);
  } catch (error) {
    // The table does not exist until the migration is run, so before then no refund can be ours.
    if (error && error.status === 404) return { matched: false };
    throw error;
  }
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { matched: false };
  if (row.payment_status === "refunded") return { matched: true, applied: false, duplicate: true };

  let full = isFullRefund(refund, row.amount_cents, null);
  if (!full) {
    const paymongo = makePaymongoClient();
    if (!paymongo.isConfigured()) throw new Error("PayMongo payment lookup unavailable");
    full = isFullRefund(refund, row.amount_cents, await paymongo.getPayment(refund.paymentId));
  }
  if (!full) return { matched: true, applied: false, ignored: true, reason: "partial_or_pending_refund" };

  await rest(url, key, `${VIRTUAL_RUN_TABLE}?id=eq.${encodeURIComponent(row.id)}&payment_status=eq.paid`, {
    method: "PATCH", prefer: "return=minimal",
    body: { payment_status: "refunded", refunded_at: refund.refundedAt || new Date().toISOString(), updated_at: new Date().toISOString() }
  });
  return { matched: true, applied: true, mode };
}

/* ---------------------------------------------------------------- emails */

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function line(value, max = 200) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const WRAP_OPEN = '<!doctype html><html><body style="margin:0;background:#f6f6f4;color:#141416;font-family:Arial,sans-serif">' +
  '<div style="max-width:560px;margin:0 auto;padding:36px 22px">' +
  '<div style="font-size:22px;font-weight:700;margin-bottom:28px">Athlevo<span style="color:#cc0010">.</span></div>';
const WRAP_CLOSE = "</div></body></html>";
const P = 'style="font-size:16px;line-height:1.6;margin:0 0 16px"';
const SMALL = 'style="font-size:13px;line-height:1.5;color:#6d7075;margin:8px 0 0"';

function formatMoment(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  }) + " (Manila)";
}

/** The runner's confirmation. Null when there is no usable address to send it to. */
export function participantEmail(row, { cfg = content, replyTo = cfg.SITE.supportEmail, links = {} } = {}) {
  const to = validEmail(row && row.email);
  if (!to) return null;
  const first = line(row.full_name, 60).split(" ")[0] || "";
  const steps = cfg.EMAIL.steps.slice();
  const pkg = packageFrom(cfg, row.package_id);
  if (pkg && pkg.id === "performance-bundle") steps.splice(2, 0, cfg.CONFIRMATION.paid.performanceStep);
  const extra = [];
  if (links.assessmentUrl) extra.push(["Running assessment", links.assessmentUrl]);
  if (links.trainingUrl) extra.push(["Training guide", links.trainingUrl]);
  const html = WRAP_OPEN +
    `<p ${P}>${first ? `Hi ${escapeHtml(first)}, ` : ""}${escapeHtml(cfg.EMAIL.intro)}</p>` +
    `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.5;margin:0 0 20px">` +
    `<tr><td style="padding:7px 12px 7px 0;color:#6d7075">Registration ID</td><td style="padding:7px 0;border-bottom:1px solid #e4e4e0"><strong>${escapeHtml(row.registration_id)}</strong></td></tr>` +
    `<tr><td style="padding:7px 12px 7px 0;color:#6d7075">Package</td><td style="padding:7px 0;border-bottom:1px solid #e4e4e0">${escapeHtml(row.package_name)}</td></tr>` +
    `<tr><td style="padding:7px 12px 7px 0;color:#6d7075">Event</td><td style="padding:7px 0;border-bottom:1px solid #e4e4e0">${escapeHtml(cfg.EVENT.name)}</td></tr>` +
    "</table>" +
    `<p ${P}><strong>${escapeHtml(cfg.CONFIRMATION.paid.stepsHeading)}</strong></p>` +
    `<ol style="font-size:16px;line-height:1.6;margin:0 0 16px;padding-left:20px">${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` +
    extra.map(([label, url]) => `<p ${P}><a href="${escapeHtml(url)}" style="color:#cc0010">${escapeHtml(label)}</a></p>`).join("") +
    `<p ${SMALL}>Questions? Reply to this email or write to ${escapeHtml(replyTo)}. We cannot promise a finish time. We can give you the structure to chase one.</p>` +
    WRAP_CLOSE;
  const textBody = [
    `${first ? `Hi ${first}, ` : ""}${cfg.EMAIL.intro}`, "",
    `Registration ID: ${row.registration_id}`, `Package: ${row.package_name}`, `Event: ${cfg.EVENT.name}`, "",
    cfg.CONFIRMATION.paid.stepsHeading, ...steps.map((step, index) => `${index + 1}. ${step}`),
    ...extra.map(([label, url]) => `${label}: ${url}`), "",
    `Questions? Reply to this email or write to ${replyTo}. We cannot promise a finish time. We can give you the structure to chase one.`
  ].join("\n");
  return { to: [to], reply_to: replyTo, subject: cfg.EMAIL.subject, html, text: textBody };
}

/**
 * The staff alert for a new paid registration. It names the person and the package but carries no
 * address, date of birth or phone number: staff read those in the protected admin page.
 */
export function staffAlertEmail(row, recipients, { cfg = content } = {}) {
  if (!row || !recipients || !recipients.length) return null;
  const pkg = packageFrom(cfg, row.package_id);
  const rows = [
    ["Name", row.full_name],
    ["Registration ID", row.registration_id],
    ["Package", row.package_name],
    ["Amount", cfg.formatPeso(row.amount_cents)],
    ["Payment method", row.payment_method_type || "not recorded"],
    ["Needs delivery", pkg && pkg.physical ? `Yes, shirt size ${row.shirt_size || "not recorded"}` : "No"],
    ["Paid", formatMoment(row.paid_at)]
  ];
  const html = WRAP_OPEN +
    `<p style="font-size:18px;font-weight:700;margin:0 0 4px">New Sub-1 10k registration</p>` +
    `<p ${SMALL}>Full details are in the registrations page.</p>` +
    '<table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.5;margin-top:16px">' +
    rows.map(([label, value]) =>
      `<tr><td style="padding:7px 12px 7px 0;color:#6d7075;white-space:nowrap">${escapeHtml(label)}</td>` +
      `<td style="padding:7px 0;border-bottom:1px solid #e4e4e0">${escapeHtml(value)}</td></tr>`).join("") +
    "</table>" + WRAP_CLOSE;
  return {
    to: recipients,
    subject: `New Sub-1 10k registration: ${line(row.full_name, 60)} (${row.package_name})`,
    html,
    text: ["New Sub-1 10k registration", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n")
  };
}

/** Tells the owner a payment could not be recorded, or was paid twice. No personal details beyond ids. */
export function paymentProblemEmail({ reason, details, row }, recipients) {
  if (!recipients || !recipients.length) return null;
  const rows = [
    ["Problem", reason],
    ["Registration ID", (row && row.registration_id) || (details && details.registrationId) || "unknown"],
    ["Reference", (details && details.referenceNumber) || "unknown"],
    ["PayMongo payment", (details && details.paymentId) || "unknown"],
    ["Amount (centavos)", String(details && details.amountCents)]
  ];
  const html = WRAP_OPEN +
    `<p style="font-size:18px;font-weight:700;margin:0 0 4px">A Sub-1 10k payment needs your attention</p>` +
    `<p ${SMALL}>The payment was taken by PayMongo but is not recorded as a normal registration. Check it in the PayMongo dashboard.</p>` +
    '<table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.5;margin-top:16px">' +
    rows.map(([label, value]) =>
      `<tr><td style="padding:7px 12px 7px 0;color:#6d7075;white-space:nowrap">${escapeHtml(label)}</td>` +
      `<td style="padding:7px 0;border-bottom:1px solid #e4e4e0;word-break:break-all">${escapeHtml(value)}</td></tr>`).join("") +
    "</table>" + WRAP_CLOSE;
  return {
    to: recipients,
    subject: `Sub-1 10k payment needs attention: ${reason}`,
    html,
    text: ["A Sub-1 10k payment needs your attention", ...rows.map(([label, value]) => `${label}: ${value}`)].join("\n")
  };
}

function ownerRecipients(env) {
  return alertRecipients({ SIGNUP_ALERT_EMAIL: env.VIRTUAL_RUN_ALERT_EMAIL || env.SIGNUP_ALERT_EMAIL });
}

/** Best effort and never throws: tell the owner about a refused or doubled payment. */
export async function notifyPaymentProblem({ reason, details, row, env = process.env }) {
  try {
    const message = paymentProblemEmail({ reason, details, row }, ownerRecipients(env));
    if (!message) return "no_recipient";
    const key = line((details && (details.paymentId || details.referenceNumber)) || reason, 80);
    return await sendEmail(message, { env, idempotencyKey: `virtual-run-problem-${key}` });
  } catch (error) {
    console.error("[virtual-run] problem alert not sent:", error && error.name);
    return "failed";
  }
}

/**
 * The runner's confirmation and the staff alert for a registration this delivery newly marked paid.
 * Best effort, never throws, and the Resend idempotency keys are a second guard against a repeat.
 * Returns { buyer, owner, attempted } like the other sign-up notifications.
 */
export async function notifyVirtualRunPaid({ row, env = process.env, cfg = content }) {
  try {
    if (!row) return null;
    const buyerMessage = participantEmail(row, {
      cfg, links: nextStepLinks(env),
      replyTo: validEmail(env.SIGNUP_REPLY_TO_EMAIL) || cfg.SITE.supportEmail
    });
    const ownerMessage = staffAlertEmail(row, ownerRecipients(env), { cfg });
    const [buyer, owner] = await Promise.all([
      buyerMessage ? sendEmail(buyerMessage, { env, idempotencyKey: `virtual-run-buyer-${row.registration_id}` }) : "no_email",
      ownerMessage ? sendEmail(ownerMessage, { env, idempotencyKey: `virtual-run-owner-${row.registration_id}` }) : "no_recipient"
    ]);
    const tried = (value) => value === "sent" || value === "failed";
    return { buyer, owner, attempted: tried(buyer) || tried(owner) };
  } catch (error) {
    console.error("[virtual-run] notifications failed:", error && error.name);
    return null;
  }
}

/** Note how the emails went on the registration (so a missing one can be diagnosed). Never throws. */
export async function recordNotificationOutcome(url, key, row, outcome) {
  try {
    if (!row || !outcome || !outcome.attempted) return false;
    await rest(url, key, `${VIRTUAL_RUN_TABLE}?registration_id=eq.${encodeURIComponent(row.registration_id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: {
        confirmation_email_status: outcome.buyer,
        confirmation_sent_at: outcome.buyer === "sent" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      }
    });
    return true;
  } catch (error) {
    console.error("[virtual-run] could not note email outcome:", error && error.status);
    return false;
  }
}
