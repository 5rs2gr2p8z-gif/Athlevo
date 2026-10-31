/*
 * Store sign-up notifications: the buyer's "next steps" email and the owner's alert.
 *
 * Sent from the signature-verified PayMongo webhook, once per NEW sign-up row. A
 * redelivered or retried event (a duplicate) never sends again, and Resend's
 * Idempotency-Key is a second guard. Best effort by design: nothing here throws, each
 * email gives up after a few seconds, and a failure never affects whether the payment
 * is recorded. Without RESEND_API_KEY it does nothing, so it stays off until configured.
 *
 * Environment:
 *   RESEND_API_KEY          the Resend account the coach invites already use (required to send)
 *   SIGNUP_FROM_EMAIL       sender, e.g. "Athlevo <noreply@athlevo.org>"; falls back to
 *                           ATHLEVO_INVITE_FROM_EMAIL, then to that same default
 *   SIGNUP_REPLY_TO_EMAIL   where a buyer's reply goes (default support@athlevo.org)
 *   SIGNUP_ALERT_EMAIL      who is alerted to each sign-up: one address, or up to five
 *                           separated by commas. No alert when it is not set.
 * The buyer's links come from the settings the confirmation page already uses:
 * *_QUESTIONNAIRE_URL, *_SCHEDULE_URL and *_AGREEMENT_URL (see planSignup.js).
 */

import { signupConfirmationUrl, signupNextSteps, signupProductFor } from "./planSignup.js";
import { formatPartnerCode } from "./partnerCodes.js";

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "Athlevo <noreply@athlevo.org>";
const DEFAULT_REPLY_TO = "support@athlevo.org";
const SEND_TIMEOUT_MS = 3500;
const MAX_ALERT_RECIPIENTS = 5;
const EMAIL_PATTERN = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** One line of plain text: control characters (including line breaks) removed, capped. */
function line(value, max = 200) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function validEmail(value) {
  const email = line(value, 254).toLowerCase();
  return EMAIL_PATTERN.test(email) ? email : null;
}

/** The people to alert: valid addresses from SIGNUP_ALERT_EMAIL, de-duplicated, at most five. */
export function alertRecipients(env = process.env) {
  const seen = new Set();
  String(env.SIGNUP_ALERT_EMAIL || "").split(/[,;\s]+/).forEach(part => {
    const email = validEmail(part);
    if (email) seen.add(email);
  });
  return [...seen].slice(0, MAX_ALERT_RECIPIENTS);
}

/** What was actually paid: the verified amount, which is the discounted price for a coded sign-up. */
function paidCents(details, product) {
  return Number.isFinite(details && details.amountCents) ? details.amountCents : product.priceCents;
}

function formatPeso(cents) {
  const pesos = Number(cents) / 100;
  return "₱" + pesos.toLocaleString("en-US", { minimumFractionDigits: Number(cents) % 100 ? 2 : 0, maximumFractionDigits: 2 });
}

function formatDay(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "long", day: "numeric" });
}

function formatMoment(iso) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleString("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  }) + " (Manila)";
}

const PAYMENT_METHODS = { qrph: "QR Ph", paymaya: "Maya", maya: "Maya", grab_pay: "GrabPay", gcash: "GCash", card: "Card" };
function paymentMethodLabel(type) {
  const key = line(type, 40).toLowerCase();
  return PAYMENT_METHODS[key] || line(type, 40);
}

function firstName(name) {
  return line(name, 60).split(" ")[0] || "";
}

const WRAP_OPEN = '<!doctype html><html><body style="margin:0;background:#f6f6f4;color:#141416;font-family:Arial,sans-serif">' +
  '<div style="max-width:560px;margin:0 auto;padding:36px 22px">' +
  '<div style="font-size:22px;font-weight:700;margin-bottom:28px">Athlevo<span style="color:#c0272d">.</span></div>';
const WRAP_CLOSE = "</div></body></html>";
const P = 'style="font-size:16px;line-height:1.6;margin:0 0 16px"';
const small = (margin = "8px 0 0") => `style="font-size:13px;line-height:1.5;color:#6d7075;margin:${margin}"`;
const BUTTON = 'style="display:inline-block;background:#c0272d;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px"';
const BUTTON_DARK = 'style="display:inline-block;background:#141416;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px"';

function link(url, label, buttonStyle) {
  return `<a href="${escapeHtml(url)}" ${buttonStyle || 'style="color:#c0272d"'}>${escapeHtml(label)}</a>`;
}

/**
 * The buyer's email: what was paid and the steps that follow, with the same links the
 * confirmation page shows. Null when PayMongo gave us no usable email address.
 */
export function buyerConfirmationEmail({ product, details, steps, confirmationUrl, replyTo }) {
  const to = validEmail(details && details.contact && details.contact.email);
  if (!to || !product || !steps || !(steps.questionnaireUrl || steps.appSignupUrl)) return null;
  const first = firstName(details.contact.name);
  const greeting = first ? `Hi ${first},` : "Hi there,";
  const amount = formatPeso(paidCents(details, product));
  const reference = line(details.referenceNumber, 80);
  // The runner's own code is repeated back so they can use it again when they renew.
  const shownCode = details.partnerCode ? formatPartnerCode(details.partnerCode) : "";
  const discountNote = shownCode && Number.isInteger(details.discountPercent)
    ? `Your discount code took ${details.discountPercent}% off. Use the same code (${shownCode}) again when you renew to keep the discount.`
    : "";
  // The Athlevo Plan sends the buyer to the Athlevo app sign-up (`steps.appSignupUrl`) instead of a
  // questionnaire and has no call. Every other offer starts with the questionnaire, then the call.
  const toApp = !steps.questionnaireUrl && Boolean(steps.appSignupUrl);
  const hasCall = !(steps && steps.call === false);
  const paymentLine = "Your payment covers one month and does not renew automatically.";

  const stepLines = toApp ? [
    "1. Create your Athlevo account.",
    "   Athlevo is the app where you finish onboarding and receive your training plan.",
    `   ${steps.appSignupUrl}`, "",
    "2. Complete your onboarding and receive your plan.",
    "   Your personalized training plan, built by an Athlevo coach, comes to you in the app."
  ] : [
    "1. Complete the Athlevo questionnaire.",
    "   Tell us about your fitness, goals, schedule, and equipment.",
    `   ${steps.questionnaireUrl}`, "",
    !hasCall
      ? "2. Your coach builds your plan.\n   An Athlevo coach uses your answers to build your personalized training plan."
      : steps.scheduleUrl
        ? `2. Schedule your call.\n   After you submit the questionnaire, you will be asked to schedule a call.\n   ${steps.scheduleUrl}`
        : "2. Schedule your call.\n   After you submit the questionnaire, you will be asked to schedule a call."
  ];
  const textParts = [
    greeting, "",
    `Thank you for signing up for ${product.name}. Your payment of ${amount} is confirmed.`,
    ...(discountNote ? [discountNote] : []),
    `Reference: ${reference}`, "",
    "What happens next:", "",
    ...stepLines
  ];
  if (steps.agreementUrl) textParts.push("", `Your agreement: ${steps.agreementUrl}`);
  if (confirmationUrl) textParts.push("", `You can reopen these steps any time: ${confirmationUrl}`);
  textParts.push("", paymentLine, "Questions? Reply to this email.", "", "Athlevo");

  let html = WRAP_OPEN +
    `<p ${P}>${escapeHtml(greeting)}</p>` +
    `<p ${P}>Thank you for signing up for ${escapeHtml(product.name)}. Your payment of ${escapeHtml(amount)} is confirmed.</p>` +
    (discountNote ? `<p ${small("0 0 8px")}>${escapeHtml(discountNote)}</p>` : "") +
    `<p ${small("0 0 24px")}>Reference: ${escapeHtml(reference)}</p>` +
    '<p style="font-size:18px;font-weight:700;margin:0 0 12px">What happens next</p>' +
    '<ol style="font-size:16px;line-height:1.6;margin:0 0 20px;padding-left:22px">' +
    (toApp
      ? '<li style="margin-bottom:18px"><strong>Create your Athlevo account.</strong><br>' +
        'Athlevo is the app where you finish onboarding and receive your training plan.<br>' +
        `<span style="display:inline-block;margin-top:10px">${link(steps.appSignupUrl, "Create your account", BUTTON)}</span></li>` +
        '<li style="margin-bottom:6px"><strong>Complete your onboarding and receive your plan.</strong><br>' +
        'Your personalized training plan, built by an Athlevo coach, comes to you in the app.</li>'
      : '<li style="margin-bottom:18px"><strong>Complete the Athlevo questionnaire.</strong><br>' +
        'Tell us about your fitness, goals, schedule, and equipment.<br>' +
        `<span style="display:inline-block;margin-top:10px">${link(steps.questionnaireUrl, "Open the questionnaire", BUTTON)}</span></li>` +
        (hasCall
          ? '<li style="margin-bottom:6px"><strong>Schedule your call.</strong><br>' +
            'After you submit the questionnaire, you will be asked to schedule a call.' +
            (steps.scheduleUrl ? `<br><span style="display:inline-block;margin-top:10px">${link(steps.scheduleUrl, "Schedule your call", BUTTON_DARK)}</span>` : "") +
            "</li>"
          : '<li style="margin-bottom:6px"><strong>Your coach builds your plan.</strong><br>' +
            'An Athlevo coach uses your answers to build your personalized training plan.</li>')) +
    "</ol>";
  if (steps.agreementUrl) {
    html += `<p ${P}>Your agreement: ${link(steps.agreementUrl, "Read the Athlevo agreement")}</p>`;
  }
  if (confirmationUrl) {
    html += `<p ${small()}>You can reopen these steps any time: ${link(confirmationUrl, "your confirmation page")}</p>`;
  }
  html += `<p ${small()}>${escapeHtml(paymentLine)} Questions? Reply to this email.</p>` + WRAP_CLOSE;

  return {
    to: [to],
    reply_to: replyTo,
    subject: `Welcome to ${product.name}: your next steps`,
    html,
    text: textParts.join("\n")
  };
}

/** The owner's alert. Every customer-supplied value is escaped; missing ones say so. */
export function ownerAlertEmail({ product, details, paidThrough, recipients, partner = null }) {
  if (!product || !details || !recipients || !recipients.length) return null;
  const contact = details.contact || {};
  const buyerEmail = validEmail(contact.email);
  const live = details.livemode === true;
  const name = line(contact.name, 80);
  const amount = formatPeso(paidCents(details, product));
  const none = "not provided";
  const batch = partner ? line(partner.label, 80) : "";
  const rows = [
    ["Offer", `${product.name} (1 month)`],
    ["Amount", amount],
    ...(partner ? [
      ["Discount", `${partner.percent}% off the ${formatPeso(product.priceCents)} price`],
      ["Discount code", formatPartnerCode(partner.code) || line(partner.code, 20)],
      ["Partner batch", batch || "unknown (code not found)"]
    ] : []),
    ["Name", name || none],
    ["Email", buyerEmail || none],
    ["Phone", line(contact.phone, 40) || none],
    ["Payment method", paymentMethodLabel(details.paymentMethodType) || none],
    ["Reference", line(details.referenceNumber, 80)],
    ["Paid", formatMoment(details.paidAt) || formatMoment(new Date().toISOString())],
    ["Paid through", formatDay(paidThrough) || none],
    ["Mode", live ? "Live payment" : "TEST payment (not real money)"]
  ];
  const sharedWarning = partner && partner.mismatch
    ? "This code was first used by a different email address, so it may have been shared. " : "";
  const note = sharedWarning + (buyerEmail
    ? "A confirmation email with their next steps goes to the address above."
    : "No email address came through from PayMongo, so no confirmation email was sent. The payer's details are in the PayMongo dashboard.");

  const html = WRAP_OPEN +
    `<p style="font-size:18px;font-weight:700;margin:0 0 4px">${live ? "" : "[TEST] "}New ${escapeHtml(product.name)} sign-up</p>` +
    `<p ${small("0 0 20px")}>${escapeHtml(amount)}${name ? " from " + escapeHtml(name) : ""}</p>` +
    '<table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.5">' +
    rows.map(([label, value]) =>
      `<tr><td style="padding:7px 12px 7px 0;color:#6d7075;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>` +
      `<td style="padding:7px 0;border-bottom:1px solid #e4e4e0;word-break:break-word">${escapeHtml(value)}</td></tr>`
    ).join("") +
    "</table>" +
    `<p ${small("20px 0 0")}>${escapeHtml(note)}</p>` + WRAP_CLOSE;

  const text = [`${live ? "" : "[TEST] "}New ${product.name} sign-up`, ""]
    .concat(rows.map(([label, value]) => `${label}: ${value}`), ["", note]).join("\n");

  return {
    to: recipients,
    subject: `${live ? "" : "[TEST] "}New ${product.name} sign-up: ${amount}${name ? " — " + name : ""}${batch ? " · " + batch : ""}`,
    html,
    text
  };
}

/** Plain-language reasons the owner sees when a payment was taken but not recorded. */
const REJECTION_REASONS = {
  wrong_amount: "The amount paid is not this offer's current price (for example, a checkout opened before a price change).",
  bad_discount: "The discount on the checkout does not match a valid partner code and percentage.",
  bad_reference: "The payment reference does not match this offer.",
  wrong_product: "The payment is tagged with a product this server does not recognise.",
  wrong_currency: "The payment is not in pesos.",
  missing_transaction_reference: "The payment has no checkout or payment id.",
  unsupported_event: "The event could not be read as a store payment."
};

/**
 * The owner's alert for a payment PayMongo took that the server refused to record. This is the only
 * way the owner hears about it: the buyer got no email and no row was written. Every value is escaped.
 */
export function rejectedPaymentAlertEmail({ details, reason, recipients }) {
  if (!details || !recipients || !recipients.length) return null;
  const contact = details.contact || {};
  const live = details.livemode === true;
  const amount = Number.isFinite(details.amountCents) ? formatPeso(details.amountCents) : "unknown amount";
  const none = "not provided";
  const rows = [
    ["Why it was not recorded", REJECTION_REASONS[reason] || "The payment failed the server's checks."],
    ["Reason code", line(reason, 60)],
    ["Amount paid", amount],
    ["Product tag", line(details.productId, 80) || none],
    ["Name", line(contact.name, 80) || none],
    ["Email", validEmail(contact.email) || none],
    ["Phone", line(contact.phone, 40) || none],
    ["Reference", line(details.referenceNumber, 80) || none],
    ["PayMongo payment id", line(details.paymentId, 80) || none],
    ["PayMongo checkout id", line(details.checkoutId, 80) || none],
    ["Mode", live ? "Live payment" : "TEST payment (not real money)"]
  ];
  const note = "The payer was charged on PayMongo, but nothing was recorded here and no confirmation email was sent. " +
    "Find this payment in the PayMongo dashboard, then record the sign-up by hand or refund it. " +
    "PayMongo retries a failed delivery for a few hours and then stops; it does not resend it.";
  const subject = `${live ? "" : "[TEST] "}Payment received but NOT recorded: ${amount}`;
  const html = WRAP_OPEN +
    `<p style="font-size:18px;font-weight:700;margin:0 0 4px">${live ? "" : "[TEST] "}Payment received but not recorded</p>` +
    `<p ${small("0 0 20px")}>${escapeHtml(amount)} was paid on PayMongo.</p>` +
    '<table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.5">' +
    rows.map(([label, value]) =>
      `<tr><td style="padding:7px 12px 7px 0;color:#6d7075;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>` +
      `<td style="padding:7px 0;border-bottom:1px solid #e4e4e0;word-break:break-word">${escapeHtml(value)}</td></tr>`
    ).join("") +
    "</table>" +
    `<p ${small("20px 0 0")}>${escapeHtml(note)}</p>` + WRAP_CLOSE;
  const text = [`${live ? "" : "[TEST] "}Payment received but NOT recorded`, ""]
    .concat(rows.map(([label, value]) => `${label}: ${value}`), ["", note]).join("\n");
  return { to: recipients, subject, html, text };
}

/**
 * Tell the owner a verified payment was refused. Best effort and never throws, like the other
 * notifications. PayMongo retries a refused event, so the idempotency key (the payment id) keeps one
 * payment from producing a dozen emails.
 */
export async function notifyRejectedSignup({ details, reason, env = process.env } = {}) {
  try {
    const message = rejectedPaymentAlertEmail({ details, reason, recipients: alertRecipients(env) });
    if (!message) return "no_recipient";
    const key = line(details.paymentId || details.referenceNumber || details.eventId, 80);
    return await deliver(message, { env, idempotencyKey: `signup-rejected-${key}` });
  } catch (error) {
    console.error("[signup-notify] unexpected error:", error && error.name);
    return "failed";
  }
}

/** Send one message through Resend. Never throws: "sent", "failed" or "not_configured". */
async function deliver(message, { env, idempotencyKey }) {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  if (!apiKey) return "not_configured";
  const from = line(env.SIGNUP_FROM_EMAIL, 200) || line(env.ATHLEVO_INVITE_FROM_EMAIL, 200) || DEFAULT_FROM;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(RESEND_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({ from, ...message })
    });
    if (!response.ok) {
      console.error("[signup-notify] email rejected, status", response.status);
      return "failed";
    }
    return "sent";
  } catch (error) {
    console.error("[signup-notify] email not sent:", error && error.name);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Notify about a newly recorded store sign-up. `result` is what applySignupPayment returned:
 * nothing is sent unless it says this payment was newly recorded. Returns null when there
 * was nothing to send, else { outcome, attempted } where outcome says how each email went
 * ("sent", "failed", "no_email", "no_recipient", "not_configured") and `attempted` is true
 * when at least one email was actually tried. Never throws.
 */
export async function notifySignup({ details, result, env = process.env } = {}) {
  try {
    if (!details || !result || result.applied !== true) return null;
    const product = signupProductFor(details.productId);
    const steps = product && signupNextSteps(details.productId, env);
    if (!product || !steps) return null;

    const buyerMessage = buyerConfirmationEmail({
      product, details, steps,
      confirmationUrl: signupConfirmationUrl(details.productId, details.referenceNumber, env),
      replyTo: validEmail(env.SIGNUP_REPLY_TO_EMAIL) || DEFAULT_REPLY_TO
    });
    const ownerMessage = ownerAlertEmail({
      product, details, paidThrough: result.paid_through, recipients: alertRecipients(env),
      partner: result.partner || null
    });
    const key = line(details.referenceNumber, 80);
    const [buyer, owner] = await Promise.all([
      buyerMessage ? deliver(buyerMessage, { env, idempotencyKey: `signup-buyer-${key}` }) : "no_email",
      ownerMessage ? deliver(ownerMessage, { env, idempotencyKey: `signup-owner-${key}` }) : "no_recipient"
    ]);
    const outcome = { buyer, owner, at: new Date().toISOString() };
    const tried = value => value === "sent" || value === "failed";
    return { outcome, attempted: tried(buyer) || tried(owner) };
  } catch (error) {
    console.error("[signup-notify] unexpected error:", error && error.name);
    return null;
  }
}

// The same sender, for other public forms (the webinar registration alert).
export { deliver as sendEmail };
