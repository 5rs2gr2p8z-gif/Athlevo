/*
 * Athlevo Sub-1 10k Challenge registration (the /virtual-run page).
 *
 *   POST /api/virtual-run/register      validate, save a PENDING registration, open a PayMongo checkout
 *   POST /api/virtual-run/status        has this registration been paid? (the confirmation screen)
 *   GET  /api/virtual-run/availability  is registration open, and is each package on sale?
 *   POST /api/virtual-run/waitlist      join or leave the priority list (lib/server/virtualRunWaitlist.js)
 *
 * The payment itself is recorded by the signature-verified PayMongo webhook
 * (lib/server/virtualRunPayments.js). Nothing on this page ever marks a registration paid.
 *
 * The rules this file keeps:
 *   - The price comes from content/virtualRun.mjs, by package id. The browser's price, if it sends one,
 *     is never read.
 *   - Registration is closed unless EVERYTHING is in place: the switch, confirmed dates, a deadline, the
 *     event rules and waiver, the database, a live PayMongo key (see registrationGate).
 *   - A registration is saved before the checkout opens, because the shirt size and address must be kept.
 *     It is "pending" until the webhook confirms the payment.
 *   - Personal details are never returned by the public endpoints. The confirmation screen gets the
 *     name only after the payment is confirmed, and only for the secret reference the runner holds.
 *
 * Environment:
 *   VIRTUAL_RUN_SIGNUP_ENABLED   "true" to open registration (server switch, off by default)
 *   VIRTUAL_RUN_SITE_URL         override the return origin (default https://athlevo.org)
 *   VIRTUAL_RUN_ASSESSMENT_URL   https link to the running assessment (optional, shown after payment)
 *   VIRTUAL_RUN_TRAINING_URL     https link to the training guide (optional, shown after payment)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAYMONGO_SECRET_KEY, PAYMONGO_PAYMENT_METHODS,
 *   PAYMONGO_WEBHOOK_SECRET      shared with the other sign-ups
 */

import crypto from "node:crypto";
import * as content from "../../content/virtualRun.mjs";
import { configuredPaymentMethods, makePaymongoClient, testKeyBlockedHere } from "./paymongoClient.js";
import { checkAnonymousAiRateLimit, rateLimitResponse } from "./rateLimit.js";
import { validEmail } from "./signupNotifications.js";

export const VIRTUAL_RUN_TABLE = "virtual_run_registrations";
export const REGISTER_SCOPE = "virtual-run-register";
export const STATUS_SCOPE = "virtual-run-status";
export const HONEYPOT_FIELD = "contact_website";
export const REFERENCE_PATTERN = /^ATH-VR-[0-9A-F]{8,16}-[0-9A-F]{24}$/;
export const REGISTRATION_ID_PATTERN = /^SUB1-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const ID_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const DB_TIMEOUT_MS = 6000;
const PHP = "PHP";

// The statuses that can still become "paid". "refunded" and "paid" never go back.
export const PAYABLE_STATUSES = Object.freeze(["pending", "expired", "failed", "cancelled"]);

// Time limits for personal bests (seconds). Wide on purpose: they only catch typos, not slow runners.
const PB_LIMITS = Object.freeze({ pb5k: [12 * 60, 90 * 60], pb10k: [25 * 60, 180 * 60] });

/* ---------------------------------------------------------------- small helpers */

/** The package with this id in the given config (a test or a future config may differ from the shipped one). */
export function packageFrom(cfg, id) {
  return (cfg.PACKAGES || []).find((item) => item.id === id) || null;
}

function asText(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** One line of plain text: control characters removed, spaces collapsed, capped. */
function line(value, max = 200) {
  return String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function send(response, status, payload) {
  if (typeof response.setHeader === "function") response.setHeader("Cache-Control", "no-store");
  return response.status(status).json(payload);
}

function httpsOrPath(value) {
  const text = String(value || "").trim();
  if (/^\/[^/\\]/.test(text)) return text;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : null;
  } catch (error) {
    return null;
  }
}

function httpsUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch (error) {
    return null;
  }
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
  const salt = process.env.OAUTH_STATE_SECRET || "athlevo-virtual-run";
  return crypto.createHash("sha256").update(`${scope}:${ip}:${salt}`).digest("hex").slice(0, 64);
}

function readJsonBody(request) {
  const body = request.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  try { return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "")); }
  catch (error) { return null; }
}

/** Today's calendar date in Manila, as { year, month, day }. */
function manilaDate(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const get = (type) => Number((parts.find((part) => part.type === type) || {}).value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/* ------------------------------------------------------------------ identifiers */

/** A short, readable registration ID, e.g. SUB1-7K3M9Q2X. No 0/O/1/I/L, so it can be read aloud. */
export function newRegistrationId() {
  let id = "SUB1-";
  for (let i = 0; i < 8; i++) id += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return id;
}

/** The long, unguessable reference PayMongo carries. Whoever holds it can open the confirmation. */
export function newReference(now = Date.now()) {
  return `ATH-VR-${now.toString(16)}-${crypto.randomBytes(12).toString("hex")}`.toUpperCase();
}

/* ------------------------------------------------------------------ the open/closed gate */

/**
 * Whether a registration may be started right now. `reasons` says what is missing (for the server log
 * only; the public answer is just a state). Closed unless every condition holds.
 */
/**
 * A full time with an offset, such as 2026-11-30T23:59:00+08:00. A date alone or a typo is refused rather than
 * guessed: a bare date would be read as midnight UTC (8am in Manila), and a typo would silently skip the check.
 */
const FULL_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
function validMoment(value) {
  const text = String(value || "").trim();
  return FULL_MOMENT.test(text) && Number.isFinite(Date.parse(text));
}

export function registrationGate({ env = process.env, now = new Date(), cfg = content } = {}) {
  const reasons = [];
  const { EVENT, REGISTRATION, LEGAL } = cfg;
  if (String(env.VIRTUAL_RUN_SIGNUP_ENABLED || "").toLowerCase() !== "true") reasons.push("VIRTUAL_RUN_SIGNUP_ENABLED is not true");
  if (!EVENT.datesConfirmed) reasons.push("EVENT.datesConfirmed is false");
  // Confirmed dates that do not add up (a typo, an end date that is not 8 weeks after the start) keep it closed too.
  const dateProblems = typeof cfg.eventDateProblems === "function" ? cfg.eventDateProblems(EVENT, REGISTRATION) : [];
  dateProblems.forEach((problem) => reasons.push(problem));
  if (!validMoment(REGISTRATION.deadline)) reasons.push("REGISTRATION.deadline is not set (use a full time with an offset, like 2026-11-30T23:59:00+08:00)");
  if (REGISTRATION.opensAt !== null && REGISTRATION.opensAt !== undefined && !validMoment(REGISTRATION.opensAt)) {
    reasons.push("REGISTRATION.opensAt is not a full time with an offset (or set it to null)");
  }
  if (!LEGAL.version || String(LEGAL.version).toLowerCase() === "unpublished") reasons.push("LEGAL.version is not set (record which rules and waiver wording runners agree to)");
  if (!httpsOrPath(LEGAL.rulesUrl)) reasons.push("LEGAL.rulesUrl is not set");
  if (!httpsOrPath(LEGAL.waiverUrl)) reasons.push("LEGAL.waiverUrl is not set");
  if (!String(env.SUPABASE_URL || "").trim() || !String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim()) reasons.push("Supabase is not configured");
  if (!String(env.PAYMONGO_SECRET_KEY || "").trim()) reasons.push("PAYMONGO_SECRET_KEY is not set");
  if (String(env.PAYMONGO_SECRET_KEY || "").trim() && testKeyBlockedHere(env)) reasons.push("production is using a PayMongo test key");
  if (!String(env.PAYMONGO_WEBHOOK_SECRET || "").trim()) reasons.push("PAYMONGO_WEBHOOK_SECRET is not set");

  const nowMs = now.getTime();
  const deadline = validMoment(REGISTRATION.deadline) ? Date.parse(REGISTRATION.deadline) : NaN;
  const opens = validMoment(REGISTRATION.opensAt) ? Date.parse(REGISTRATION.opensAt) : null;
  let state = "open";
  if (reasons.length) state = "not_open";
  else if (Number.isFinite(opens) && nowMs < opens) state = "not_open";
  else if (nowMs > deadline) state = "closed";
  return { open: state === "open", state, reasons };
}

/* ------------------------------------------------------------------ validation */

/** "24:30" or "1:05:00" -> seconds, or null when it is not a time. */
export function parseRaceTime(value) {
  const text = line(value, 12);
  const match = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/.exec(text);
  if (!match) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  return hours * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function formatRaceTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

function validDateOfBirth(value, now, minAge) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(line(value, 10));
  if (!match) return { ok: false, field: "dob" };
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return { ok: false, field: "dob" };
  const today = manilaDate(now);
  let age = today.year - year;
  if (today.month < month || (today.month === month && today.day < day)) age -= 1;
  if (age < 0 || age > 110) return { ok: false, field: "dob" };
  if (age < minAge) return { ok: false, field: "dob", code: "dobAge" };
  return { ok: true, value: `${match[1]}-${match[2]}-${match[3]}` };
}

/**
 * Checks one submission against the config. Returns { ok: true, value } with cleaned values, or
 * { ok: false, fields } where fields maps each unacceptable field to its message key. The browser
 * runs the same checks for quick feedback (js/virtualRun.js); this is the one that counts.
 * Any price, amount or total in the body is never read.
 */
export function validateRegistration(body, { now = new Date(), cfg = content } = {}) {
  const input = body && typeof body === "object" ? body : {};
  const fields = {};
  const value = {};
  const bad = (field, code) => { fields[field] = code || field; };

  value.fullName = line(asText(input.fullName), 120);
  if (value.fullName.length < 2) bad("fullName");

  const email = validEmail(asText(input.email));
  if (!email) bad("email"); else value.email = email;

  value.mobile = line(asText(input.mobile), 40).replace(/[\s().\-]/g, "");
  if (!/^\+?\d{7,15}$/.test(value.mobile)) bad("mobile");

  const dob = validDateOfBirth(asText(input.dob), now, cfg.ELIGIBILITY.minAge);
  if (!dob.ok) bad("dob", dob.code); else value.dob = dob.value;

  const gender = asText(input.gender);
  if (gender && !cfg.GENDERS.some((option) => option.value === gender)) bad("gender");
  else value.gender = gender || null;

  for (const [field, key] of [["pb5k", "pb_5k"], ["pb10k", "pb_10k"]]) {
    const raw = line(asText(input[field]), 12);
    if (!raw) { value[key] = null; continue; }
    const seconds = parseRaceTime(raw);
    const [low, high] = PB_LIMITS[field];
    if (seconds === null || seconds < low || seconds > high) bad(field);
    else value[key] = formatRaceTime(seconds);
  }

  const frequency = asText(input.frequency);
  if (!cfg.FREQUENCIES.some((option) => option.value === frequency)) bad("frequency"); else value.frequency = frequency;
  const goal = asText(input.goal);
  if (!cfg.GOALS.some((option) => option.value === goal)) bad("goal"); else value.goal = goal;

  const pkg = packageFrom(cfg, asText(input.packageId));
  if (!pkg || !pkg.available) bad("package"); else value.packageId = pkg.id;

  value.shipping = null;
  if (pkg && pkg.physical) {
    const shipping = {};
    const size = asText(input.shirtSize);
    if (!cfg.SHIRT_SIZES.includes(size)) bad("shirtSize"); else shipping.shirtSize = size;
    shipping.recipient = line(asText(input.recipient), 120);
    if (shipping.recipient.length < 2) bad("recipient");
    shipping.address = line(asText(input.address), 200);
    if (shipping.address.length < 5) bad("address");
    const province = asText(input.province);
    if (!cfg.PROVINCES.includes(province)) bad("province");
    else if (Array.isArray(cfg.DELIVERY.provinces) && !cfg.DELIVERY.provinces.includes(province)) bad("province", "delivery");
    else shipping.province = province;
    shipping.city = line(asText(input.city), 100);
    if (shipping.city.length < 2) bad("city");
    shipping.barangay = line(asText(input.barangay), 100);
    if (shipping.barangay.length < 2) bad("barangay");
    shipping.postal = line(asText(input.postal), 10);
    if (!/^\d{4}$/.test(shipping.postal)) bad("postal");
    value.shipping = shipping;
  }

  // Consent has to be an explicit true. "true" or 1 from a script does not count.
  if (input.agreeRules !== true) bad("rules");
  if (input.agreePrivacy !== true) bad("privacy");

  if (Object.keys(fields).length) return { ok: false, fields };
  return { ok: true, value };
}

/* ------------------------------------------------------------------ database */

function supabase(env) {
  const url = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) return null;
  return {
    async rest(path, { method = "GET", body, prefer, count = false } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
      try {
        const headers = {
          apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json"
        };
        const preferences = [prefer, count ? "count=exact" : ""].filter(Boolean).join(",");
        if (preferences) headers.Prefer = preferences;
        const response = await globalThis.fetch(`${url}/rest/v1/${path}`, {
          method, signal: controller.signal, headers, body: body === undefined ? undefined : JSON.stringify(body)
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
        let total = null;
        if (count) {
          const range = response.headers && response.headers.get ? response.headers.get("content-range") : null;
          const match = /\/(\d+)$/.exec(String(range || ""));
          total = match ? Number(match[1]) : null;
        }
        return { data, total };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * How many spots are taken: paid registrations, plus unpaid ones still inside their hold time.
 * `packageId` narrows it to one package. Returns null when it cannot be counted.
 */
async function takenSpots(db, { cfg, now, packageId = null }) {
  const filters = [
    `event=eq.${encodeURIComponent(cfg.EVENT.id)}`,
    `or=(payment_status.eq.paid,and(payment_status.eq.pending,hold_expires_at.gt.${encodeURIComponent(now.toISOString())}))`
  ];
  if (packageId) filters.push(`package_id=eq.${encodeURIComponent(packageId)}`);
  try {
    const result = await db.rest(`${VIRTUAL_RUN_TABLE}?${filters.join("&")}&select=id&limit=1`, { count: true });
    return Number.isFinite(result.total) ? result.total : null;
  } catch (error) {
    console.error("[virtual-run] could not count registrations:", error && error.status);
    return null;
  }
}

/** Every package's sale status for the public page: "available", "soon", "sold_out" or "closed". */
export async function packageStatuses({ env = process.env, now = new Date(), cfg = content, db = supabase(env) } = {}) {
  let eventFull = false;
  if (cfg.REGISTRATION.limit && db) {
    const taken = await takenSpots(db, { cfg, now });
    eventFull = taken === null ? true : taken >= cfg.REGISTRATION.limit;
  }
  const statuses = [];
  for (const pkg of cfg.PACKAGES) {
    let status = "available";
    if (!pkg.available) status = "closed";
    else if (pkg.physical && !cfg.DELIVERY.confirmed) status = "soon";
    else if (eventFull) status = "sold_out";
    else if (pkg.limit && db) {
      const taken = await takenSpots(db, { cfg, now, packageId: pkg.id });
      if (taken === null || taken >= pkg.limit) status = "sold_out";
    }
    statuses.push({ id: pkg.id, status });
  }
  return statuses;
}

/* ------------------------------------------------------------------ rows and checkout */

export function siteUrl(env = process.env) {
  const override = httpsUrl(env.VIRTUAL_RUN_SITE_URL);
  if (override) return override.replace(/\/+$/, "");
  if (env.VERCEL_ENV === "preview" && env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "https://athlevo.org";
}

/** The row saved for a new, unpaid registration. The amount is the server's, never the browser's. */
export function pendingRow(value, { registrationId, reference, now = new Date(), cfg = content } = {}) {
  const pkg = packageFrom(cfg, value.packageId);
  const shipping = value.shipping || {};
  return {
    registration_id: registrationId,
    reference_number: reference,
    event: cfg.EVENT.id,
    package_id: pkg.id,
    package_name: pkg.name,
    product_id: pkg.productId,
    amount_cents: pkg.priceCents,
    currency: PHP,
    payment_status: "pending",
    hold_expires_at: new Date(now.getTime() + cfg.REGISTRATION.holdMinutes * 60000).toISOString(),
    full_name: value.fullName,
    email: value.email,
    mobile: value.mobile,
    date_of_birth: value.dob,
    gender: value.gender,
    pb_5k: value.pb_5k,
    pb_10k: value.pb_10k,
    weekly_frequency: value.frequency,
    primary_goal: value.goal,
    shirt_size: shipping.shirtSize || null,
    recipient_name: shipping.recipient || null,
    address_line: shipping.address || null,
    province: shipping.province || null,
    city: shipping.city || null,
    barangay: shipping.barangay || null,
    postal_code: shipping.postal || null,
    rules_accepted_at: now.toISOString(),
    privacy_accepted_at: now.toISOString(),
    legal_version: cfg.LEGAL.version,
    metadata: { source: "virtual-run-page" }
  };
}

/** The PayMongo Hosted Checkout request for a saved registration. */
export function checkoutAttributes(row, { env = process.env, cfg = content } = {}) {
  const description = `${cfg.EVENT.name}, ${row.package_name}`;
  const returnUrl = `${siteUrl(env)}${cfg.SITE.path}`;
  return {
    line_items: [{
      name: `${cfg.EVENT.name}: ${row.package_name}`,
      description,
      amount: row.amount_cents,
      currency: row.currency,
      quantity: 1
    }],
    payment_method_types: configuredPaymentMethods(env.PAYMONGO_PAYMENT_METHODS),
    success_url: `${returnUrl}?payment=success&ref=${encodeURIComponent(row.reference_number)}`,
    cancel_url: `${returnUrl}?payment=cancelled&ref=${encodeURIComponent(row.reference_number)}`,
    reference_number: row.reference_number,
    send_email_receipt: true,
    show_description: true,
    show_line_items: true,
    description,
    metadata: {
      athlevo_product: row.product_id,
      athlevo_source: "virtual-run",
      athlevo_event: row.event,
      athlevo_registration: row.registration_id
    }
  };
}

/* ------------------------------------------------------------------ handlers */

/** Inserts the pending row, retrying with a fresh ID in the (very unlikely) event of an ID clash. */
async function savePendingRegistration(db, value, { now, cfg }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = pendingRow(value, { registrationId: newRegistrationId(), reference: newReference(now.getTime()), now, cfg });
    try {
      await db.rest(VIRTUAL_RUN_TABLE, { method: "POST", body: row, prefer: "return=minimal" });
      return row;
    } catch (error) {
      if (error && error.status === 409) continue;
      throw error;
    }
  }
  throw new Error("could not create a unique registration id");
}

/** The same runner: the same email and the same name (case and spacing ignored). Families and couples may share an email. */
export function sameRunner(a, b) {
  const key = (value) => line(asText(value), 120).toLowerCase();
  return Boolean(key(a) && key(a) === key(b));
}

/** Paid registrations for this email in this event: [{ full_name, registration_id }]. null when it cannot be read. */
export async function paidForEmail(db, email, cfg) {
  try {
    const result = await db.rest(
      `${VIRTUAL_RUN_TABLE}?event=eq.${encodeURIComponent(cfg.EVENT.id)}&payment_status=eq.paid` +
      `&email=eq.${encodeURIComponent(email)}&select=full_name,registration_id&limit=20`);
    return Array.isArray(result.data) ? result.data : [];
  } catch (error) {
    return null;
  }
}

async function alreadyRegistered(db, value, cfg) {
  const paid = await paidForEmail(db, value.email, cfg);
  // Cannot tell: do not block someone from registering because a lookup failed.
  return Boolean(paid && paid.some((row) => sameRunner(row.full_name, value.fullName)));
}

/**
 * A runner who tries again (back button, cancelled checkout) leaves their earlier unpaid attempt behind. It is
 * released so it stops holding a spot. Its PayMongo session can still be paid, and the webhook flags that case.
 */
async function releaseEarlierAttempts(db, value, { now, cfg }) {
  try {
    await db.rest(
      `${VIRTUAL_RUN_TABLE}?event=eq.${encodeURIComponent(cfg.EVENT.id)}&payment_status=eq.pending` +
      `&email=eq.${encodeURIComponent(value.email)}&full_name=eq.${encodeURIComponent(value.fullName)}`,
      { method: "PATCH", body: { payment_status: "cancelled", updated_at: now.toISOString() }, prefer: "return=minimal" });
  } catch (error) {
    // Only costs a held spot for the rest of the hour.
  }
}

/** POST /api/virtual-run/register */
export async function registerHandler(request, response, { env = process.env, now = new Date(), cfg = content, paymongo = null } = {}) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }
  const body = readJsonBody(request);
  if (!body || typeof body !== "object") return send(response, 400, { error: "invalid", fields: {} });

  // A hidden field people never see. If it is filled, a bot did it: look successful, save nothing.
  const trap = body[HONEYPOT_FIELD];
  if (trap !== undefined && trap !== null && trap !== false && line(asText(trap), 200)) {
    return send(response, 200, { ok: true });
  }

  const gate = registrationGate({ env, now, cfg });
  if (!gate.open) {
    console.warn(`[virtual-run] registration refused: ${gate.state}${gate.reasons.length ? ` (${gate.reasons.join("; ")})` : ""}`);
    return send(response, 503, { error: gate.state === "closed" ? "closed" : "not_open" });
  }

  const limit = await checkAnonymousAiRateLimit(clientKey(request, REGISTER_SCOPE), REGISTER_SCOPE);
  if (!limit.allowed) return rateLimitResponse(response, limit);

  const checked = validateRegistration(body, { now, cfg });
  if (!checked.ok) return send(response, 400, { error: "invalid", fields: checked.fields });
  const value = checked.value;

  const db = supabase(env);
  if (!db) return send(response, 503, { error: "not_open" });

  const statuses = await packageStatuses({ env, now, cfg, db });
  const status = (statuses.find((item) => item.id === value.packageId) || {}).status;
  if (status === "sold_out") return send(response, 409, { error: "full" });
  if (status !== "available") return send(response, 503, { error: "not_open" });

  if (await alreadyRegistered(db, value, cfg)) return send(response, 409, { error: "already_registered" });
  await releaseEarlierAttempts(db, value, { now, cfg });

  let row;
  try {
    row = await savePendingRegistration(db, value, { now, cfg });
  } catch (error) {
    // A 404 here almost always means the migration has not been run yet.
    console.error(`[virtual-run] registration not saved, database status ${error && error.status}` +
      (error && error.status === 404 ? " (run migrations/2026-11-14_virtual_run_registrations.sql)" : ""));
    return send(response, 503, { error: "unavailable" });
  }

  try {
    const client = paymongo || makePaymongoClient(env.PAYMONGO_SECRET_KEY);
    const session = await client.createCheckoutSession(checkoutAttributes(row, { env, cfg }));
    // Best effort: the webhook matches on the reference, so a failed note here loses nothing.
    await db.rest(`${VIRTUAL_RUN_TABLE}?registration_id=eq.${encodeURIComponent(row.registration_id)}`, {
      method: "PATCH", body: { provider_checkout_id: session.id, updated_at: now.toISOString() }, prefer: "return=minimal"
    }).catch(() => null);
    return send(response, 200, { checkout_url: session.checkoutUrl, ref: row.reference_number });
  } catch (error) {
    console.error("[virtual-run] checkout creation failed:", error && error.message);
    await db.rest(`${VIRTUAL_RUN_TABLE}?registration_id=eq.${encodeURIComponent(row.registration_id)}&payment_status=eq.pending`, {
      method: "PATCH",
      body: { payment_status: "failed", updated_at: now.toISOString(), metadata: { source: "virtual-run-page", checkout_error: true } },
      prefer: "return=minimal"
    }).catch(() => null);
    return send(response, 502, { error: "checkout_failed" });
  }
}

/** Where a confirmed runner is sent for the assessment and the training guide (both optional). */
export function nextStepLinks(env = process.env) {
  return { assessmentUrl: httpsUrl(env.VIRTUAL_RUN_ASSESSMENT_URL), trainingUrl: httpsUrl(env.VIRTUAL_RUN_TRAINING_URL) };
}

/** POST /api/virtual-run/status { ref } */
export async function statusHandler(request, response, { env = process.env, cfg = content } = {}) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }
  const db = supabase(env);
  if (!db) return send(response, 503, { error: "unavailable" });
  const body = readJsonBody(request);
  const reference = body && typeof body.ref === "string" ? body.ref.trim().toUpperCase() : "";
  if (!REFERENCE_PATTERN.test(reference)) return send(response, 400, { error: "invalid_reference" });

  const limit = await checkAnonymousAiRateLimit(clientKey(request, STATUS_SCOPE), STATUS_SCOPE);
  if (!limit.allowed) return rateLimitResponse(response, limit);

  try {
    const result = await db.rest(
      `${VIRTUAL_RUN_TABLE}?reference_number=eq.${encodeURIComponent(reference)}` +
      "&select=payment_status,registration_id,full_name,package_id,package_name,confirmation_email_status&limit=1");
    const row = Array.isArray(result.data) ? result.data[0] : null;
    if (!row) return send(response, 200, { status: "pending" });
    if (row.payment_status !== "paid") return send(response, 200, { status: row.payment_status });
    const pkg = packageFrom(cfg, row.package_id);
    const links = nextStepLinks(env);
    return send(response, 200, {
      status: "paid",
      registration_id: row.registration_id,
      name: row.full_name,
      package: { id: row.package_id, name: row.package_name, physical: Boolean(pkg && pkg.physical) },
      email_sent: row.confirmation_email_status === "sent",
      assessment_url: links.assessmentUrl,
      training_url: links.trainingUrl
    });
  } catch (error) {
    console.error("[virtual-run] status lookup failed:", error && error.status);
    return send(response, 502, { error: "unavailable" });
  }
}

/** GET /api/virtual-run/availability: no personal data, so it may be cached at the edge for a moment. */
export async function availabilityHandler(request, response, { env = process.env, now = new Date(), cfg = content } = {}) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return send(response, 405, { error: "Method not allowed." });
  }
  const gate = registrationGate({ env, now, cfg });
  let packages = cfg.PACKAGES.map((pkg) => ({ id: pkg.id, status: "closed" }));
  let state = gate.state;
  if (gate.open) {
    packages = await packageStatuses({ env, now, cfg });
    if (packages.every((item) => item.status === "sold_out")) state = "sold_out";
    else if (packages.every((item) => item.status !== "available")) state = "not_open";
  }
  if (typeof response.setHeader === "function") response.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=40");
  return response.status(200).json({ state, packages, waitlist: waitlistOpen({ env, cfg }) });
}

/**
 * Whether the priority list can take sign-ups: it is switched on in the content file and the database is
 * configured. The list never involves payment, so it does not depend on the registration gate.
 */
export function waitlistOpen({ env = process.env, cfg = content } = {}) {
  if (!cfg.WAITLIST || cfg.WAITLIST.enabled === false) return false;
  return Boolean(String(env.SUPABASE_URL || "").trim() && String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim());
}

// Helpers the priority list (lib/server/virtualRunWaitlist.js) shares with the registration code.
export { asText, clientKey, line, readJsonBody, send, supabase };
