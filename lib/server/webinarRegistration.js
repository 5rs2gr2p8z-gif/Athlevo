/*
 * Webinar registration (the /webinar page): POST /api/webinar/register.
 *
 * What it does with one submission, in order:
 *   1. Honeypot. The form carries a hidden field people never see. If it is filled the sender is
 *      a bot: answer "ok" (so it learns nothing) and store and send nothing.
 *   2. Rate limit per visitor, so a script cannot flood the table or your inbox.
 *   3. Validate every field on the server (the browser's checks are only for quick feedback).
 *   4. Save the registration to public.webinar_registrations AND email you an alert, at the same
 *      time. The runner is told "registered" if EITHER worked, so one missing setting never loses
 *      a lead. If both fail they are told something went wrong, and nothing is silently dropped.
 *
 * Environment (all already used by the paid sign-up flow):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   where registrations are saved (run the migration first)
 *   RESEND_API_KEY                            sends the alert email
 *   SIGNUP_ALERT_EMAIL                        who gets the alert (one address, or up to five, comma separated)
 *   WEBINAR_ALERT_EMAIL (optional)            use this instead of SIGNUP_ALERT_EMAIL for webinar alerts only
 *   SIGNUP_FROM_EMAIL (optional)              the sender, same as the sign-up emails
 *
 * Runs inside the existing API gateway (api/providers/index.js, action webinar_register) because the
 * Vercel plan is at its function limit. Without JavaScript the browser posts the form as
 * form-encoded data; that is answered with a redirect instead of JSON.
 */

import crypto from "node:crypto";
import { DISTANCES, TRAINING, SITE } from "../../content/webinar.mjs";
import { checkAnonymousAiRateLimit, rateLimitResponse } from "./rateLimit.js";
import { alertRecipients, sendEmail, validEmail } from "./signupNotifications.js";

export const WEBINAR_EVENT = "ignite-the-grit-2026";
export const WEBINAR_RATE_SCOPE = "webinar-register";
export const HONEYPOT_FIELD = "contact_website";
const TABLE = "webinar_registrations";
const DB_TIMEOUT_MS = 6000;
const FORM_PATH = "/webinar/#register";

const DISTANCE_LABELS = new Map(DISTANCES.map(option => [option.value, option.label]));
const TRAINING_LABELS = new Map(TRAINING.map(option => [option.value, option.label]));

/** A submitted value as text. Only strings and numbers count; an object or array becomes empty. */
function asText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** One line of plain text: control characters (including line breaks) removed, spaces collapsed, capped. */
function line(value, max = 200) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Free text that may span lines: control characters other than line breaks removed, capped. */
function paragraph(value, max = 1000) {
  return String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

/**
 * Checks one submission. Returns { ok: true, value } with cleaned values, or
 * { ok: false, fields } naming every field that is not acceptable. Mirrors js/webinar.js.
 */
export function validateRegistration(body) {
  const input = body && typeof body === "object" ? body : {};
  const fields = {};

  const name = line(asText(input.name), 120);
  if (name.length < 2) fields.name = true;

  // Any mobile number a person could be messaged on: 7 to 15 digits, an optional leading +.
  const mobile = line(asText(input.mobile), 40).replace(/[\s().\-]/g, "");
  if (!/^\+?\d{7,15}$/.test(mobile)) fields.mobile = true;

  const rawEmail = line(asText(input.email), 254);
  const email = rawEmail ? validEmail(rawEmail) : null;
  if (rawEmail && !email) fields.email = true;

  const distance = typeof input.distance === "string" ? input.distance : "";
  if (!DISTANCE_LABELS.has(distance)) fields.distance = true;

  const training = typeof input.training === "string" ? input.training : "";
  if (!TRAINING_LABELS.has(training)) fields.training = true;

  if (Object.keys(fields).length) return { ok: false, fields };
  return {
    ok: true,
    value: { name, mobile, email, distance, training, question: paragraph(asText(input.question), 1000) || null }
  };
}

/** The row saved to public.webinar_registrations. */
export function registrationRow(value) {
  return {
    event: WEBINAR_EVENT,
    name: value.name,
    mobile: value.mobile,
    email: value.email,
    distance: value.distance,
    training: value.training,
    question: value.question
  };
}

function formatMoment(date = new Date()) {
  return date.toLocaleString("en-US", {
    timeZone: "Asia/Manila", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  }) + " (Manila)";
}

/** The alert to the owner. Every runner-supplied value is escaped; missing ones say so. */
export function registrationAlertEmail(value, recipients, now = new Date()) {
  if (!value || !recipients || !recipients.length) return null;
  const none = "not provided";
  const rows = [
    ["Name", value.name],
    ["Mobile", value.mobile],
    ["Email", value.email || none],
    ["Race distance", DISTANCE_LABELS.get(value.distance) || value.distance],
    ["How they train", TRAINING_LABELS.get(value.training) || value.training],
    ["Question", value.question || none],
    ["Registered", formatMoment(now)]
  ];
  const html =
    '<!doctype html><html><body style="margin:0;background:#f6f6f4;color:#141416;font-family:Arial,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;padding:36px 22px">' +
    '<div style="font-size:22px;font-weight:700;margin-bottom:28px">Athlevo<span style="color:#c0272d">.</span></div>' +
    '<p style="font-size:18px;font-weight:700;margin:0 0 4px">New webinar registration</p>' +
    `<p style="font-size:13px;line-height:1.5;color:#6d7075;margin:0 0 20px">${escapeHtml(value.name)}</p>` +
    '<table role="presentation" style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.5">' +
    rows.map(([label, text]) =>
      `<tr><td style="padding:7px 12px 7px 0;color:#6d7075;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>` +
      `<td style="padding:7px 0;border-bottom:1px solid #e4e4e0;word-break:break-word;white-space:pre-wrap">${escapeHtml(text)}</td></tr>`
    ).join("") +
    "</table></div></body></html>";
  const text = ["New webinar registration", ""].concat(rows.map(([label, v]) => `${label}: ${v}`)).join("\n");
  return {
    to: recipients,
    subject: `New webinar registration: ${line(value.name, 60)} · ${DISTANCE_LABELS.get(value.distance) || value.distance}`,
    html,
    text
  };
}

function send(response, status, payload) {
  if (typeof response.setHeader === "function") response.setHeader("Cache-Control", "no-store");
  return response.status(status).json(payload);
}

function redirect(response, location) {
  if (typeof response.setHeader === "function") {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Location", location);
  }
  response.status(303);
  return typeof response.end === "function" ? response.end() : response.json({ ok: true, redirect: location });
}

function clientIp(request) {
  const headers = request.headers || {};
  const forwarded = headers["x-forwarded-for"] || headers["x-real-ip"] || "";
  const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")[0].trim();
  return first || (request.socket && request.socket.remoteAddress) || "";
}

function clientKey(request, scope) {
  const ip = clientIp(request);
  if (!ip) return `${scope}-unknown`;
  const salt = process.env.OAUTH_STATE_SECRET || "athlevo-webinar";
  return crypto.createHash("sha256").update(`${scope}:${ip}:${salt}`).digest("hex").slice(0, 64);
}

/** The submitted fields as an object, from JSON or from a plain form post. */
function readBody(request) {
  const body = request.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  const raw = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  try { return JSON.parse(raw); } catch (error) { /* maybe form-encoded */ }
  try { return Object.fromEntries(new URLSearchParams(raw)); } catch (error) { return null; }
}

function isFormPost(request) {
  const type = String((request.headers && request.headers["content-type"]) || "").toLowerCase();
  return type.includes("application/x-www-form-urlencoded");
}

/** True when the hidden field holds anything at all (a bot filled it). */
function trapFilled(value) {
  if (typeof value === "string") return line(value, 200).length > 0;
  return value !== undefined && value !== null && value !== false;
}

/** Saves the row. "stored", "failed" or "not_configured". Never throws. */
async function storeRegistration(row, env) {
  const url = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return "not_configured";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    const result = await globalThis.fetch(`${url}/rest/v1/${TABLE}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json",
        "Content-Type": "application/json", Prefer: "return=minimal"
      },
      body: JSON.stringify(row)
    });
    if (!result.ok) {
      // A 404 here almost always means the migration has not been run yet.
      console.error(`[webinar] registration not saved, database status ${result.status}` +
        (result.status === 404 ? " (run migrations/2026-10-27_webinar_registrations.sql)" : ""));
      return "failed";
    }
    return "stored";
  } catch (error) {
    console.error("[webinar] registration not saved:", error && error.name);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

/** Emails the alert. "sent", "failed", "not_configured" or "no_recipient". Never throws. */
async function alertOwner(value, env) {
  const recipients = alertRecipients({ SIGNUP_ALERT_EMAIL: env.WEBINAR_ALERT_EMAIL || env.SIGNUP_ALERT_EMAIL });
  const message = registrationAlertEmail(value, recipients);
  if (!message) return "no_recipient";
  try {
    return await sendEmail(message, { env, idempotencyKey: `webinar-${crypto.randomUUID()}` });
  } catch (error) {
    console.error("[webinar] alert email not sent:", error && error.name);
    return "failed";
  }
}

export default async function webinarRegisterHandler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }
  const form = isFormPost(request);
  const body = readBody(request);
  const fail = (status, payload) => (form ? redirect(response, FORM_PATH) : send(response, status, payload));
  if (!body || typeof body !== "object") return fail(400, { error: "invalid", fields: {} });

  // 1. Honeypot: a real person never sees this field.
  if (trapFilled(body[HONEYPOT_FIELD])) {
    return form ? redirect(response, SITE.thankYouPath) : send(response, 200, { ok: true });
  }

  // 2. Rate limit per visitor.
  const limit = await checkAnonymousAiRateLimit(clientKey(request, WEBINAR_RATE_SCOPE), WEBINAR_RATE_SCOPE);
  if (!limit.allowed) return form ? redirect(response, FORM_PATH) : rateLimitResponse(response, limit);

  // 3. Validate on the server.
  const checked = validateRegistration(body);
  if (!checked.ok) return fail(400, { error: "invalid", fields: checked.fields });

  // 4. Save and alert at the same time; success if either one worked.
  const env = process.env;
  const [stored, alerted] = await Promise.all([
    storeRegistration(registrationRow(checked.value), env),
    alertOwner(checked.value, env)
  ]);
  if (stored !== "stored" && alerted !== "sent") {
    console.error(`[webinar] registration lost: save ${stored}, alert ${alerted}`);
    return fail(503, { error: "unavailable" });
  }
  return form ? redirect(response, SITE.thankYouPath) : send(response, 200, { ok: true });
}
