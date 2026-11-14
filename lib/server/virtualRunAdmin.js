/*
 * Sub-1 10k Challenge registrations: the staff-only endpoint behind /virtual-run/admin.
 *
 *   GET /api/virtual-run/admin?...               JSON: the registrations that match the filters, plus counts
 *   GET /api/virtual-run/admin?format=csv&...    the same rows as a CSV download (merchandise fulfillment)
 *
 * Who may use it is decided HERE, on the server, on every request. The page only shows a sign-in; it
 * does not decide anything. A caller must send a valid Supabase access token, and that user must be on
 * a staff list:
 *   VIRTUAL_RUN_STAFF_USER_IDS   comma-separated Supabase user ids
 *   VIRTUAL_RUN_STAFF_EMAILS     comma-separated emails (only an email Supabase has CONFIRMED counts)
 *   ADMIN_USER_IDS               the founder list already used by the analytics dashboard
 * With none of them set, nobody gets in.
 *
 * Filters (all optional): package=<id>, status=<payment status>, q=<name, email or registration ID>,
 * fulfillment=1 (paid orders that need a delivery), limit=<rows>.
 *
 * The CSV holds only what is needed to pack and ship an order. Date of birth, running details and
 * goals stay in the admin page. Nothing here is public: every response is no-store and noindex.
 */

import * as content from "../../content/virtualRun.mjs";
import { VIRTUAL_RUN_TABLE, packageFrom } from "./virtualRun.js";

const DB_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;
export const PAYMENT_STATUSES = Object.freeze(["pending", "paid", "failed", "expired", "cancelled", "refunded"]);

const COLUMNS = [
  "registration_id", "payment_status", "package_id", "package_name", "amount_cents", "full_name", "email", "mobile",
  "date_of_birth", "gender", "pb_5k", "pb_10k", "weekly_frequency", "primary_goal", "shirt_size", "recipient_name",
  "address_line", "province", "city", "barangay", "postal_code", "payment_method_type", "livemode", "paid_at",
  "created_at", "result_status", "confirmation_email_status"
].join(",");

function list(value) {
  return String(value || "").split(/[,;\s]+/).map((part) => part.trim()).filter(Boolean);
}

/** True when this verified Supabase user is on a staff list. */
export function staffAllowed(user, env = process.env) {
  if (!user || !user.id) return false;
  const ids = new Set([...list(env.VIRTUAL_RUN_STAFF_USER_IDS), ...list(env.ADMIN_USER_IDS)]);
  if (ids.has(String(user.id))) return true;
  const emails = new Set(list(env.VIRTUAL_RUN_STAFF_EMAILS).map((email) => email.toLowerCase()));
  const email = String(user.email || "").toLowerCase();
  const confirmed = Boolean(user.email_confirmed_at || user.confirmed_at);
  return Boolean(email && confirmed && emails.has(email));
}

/* ---------------------------------------------------------------- CSV */

/**
 * One CSV cell. Quotes are doubled and the cell is quoted when needed. A cell that a spreadsheet would
 * run as a formula (it starts with = + - @ or a tab or return) gets a leading apostrophe, so text a
 * runner typed can never execute. A plain phone number such as +639171234567 is left alone.
 */
export function csvCell(value) {
  let cell = value == null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(cell) && !/^\+?\d[\d ]*$/.test(cell)) cell = "'" + cell;
  return /[",\r\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
}

function manilaStamp(iso) {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date(time));
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}`;
}

export const CSV_HEADERS = Object.freeze([
  "Registration ID", "Payment status", "Test payment", "Package", "Shirt size", "Recipient name", "Mobile", "Email",
  "Address", "Barangay", "City or municipality", "Province", "Postal code", "Paid at (Manila)", "Registered at (Manila)"
]);

/** The fulfillment CSV for these rows, with a byte-order mark so Excel reads the peso and accents correctly. */
export function buildCsv(rows) {
  const lines = [CSV_HEADERS.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.registration_id, row.payment_status, row.livemode === false ? "yes" : "no", row.package_name, row.shirt_size,
      row.recipient_name, row.mobile, row.email, row.address_line, row.barangay, row.city, row.province, row.postal_code,
      manilaStamp(row.paid_at), manilaStamp(row.created_at)
    ].map(csvCell).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/* ---------------------------------------------------------------- query */

/** A search term made safe to put inside a PostgREST filter: letters, digits, spaces and @ . _ + - only. */
export function safeSearch(value) {
  return String(value || "").replace(/[^\p{L}\p{N} @._+\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function parseFilters(query, cfg = content) {
  const q = query || {};
  const one = (value) => (Array.isArray(value) ? value[0] : value);
  const packageId = String(one(q.package) || "all");
  const status = String(one(q.status) || "all");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(one(q.limit), 10) || DEFAULT_LIMIT));
  return {
    packageId: packageId !== "all" && packageFrom(cfg, packageId) ? packageId : null,
    status: PAYMENT_STATUSES.includes(status) ? status : null,
    search: safeSearch(one(q.q)),
    fulfillment: String(one(q.fulfillment) || "") === "1",
    csv: String(one(q.format) || "").toLowerCase() === "csv",
    limit
  };
}

export function listQuery(filters, cfg = content) {
  const parts = [`event=eq.${encodeURIComponent(cfg.EVENT.id)}`];
  if (filters.packageId) parts.push(`package_id=eq.${encodeURIComponent(filters.packageId)}`);
  if (filters.status) parts.push(`payment_status=eq.${filters.status}`);
  if (filters.fulfillment) {
    parts.push("payment_status=eq.paid");
    const physical = cfg.PACKAGES.filter((pkg) => pkg.physical).map((pkg) => pkg.id);
    parts.push(`package_id=in.(${physical.join(",")})`);
  }
  if (filters.search.length >= 2) {
    const term = encodeURIComponent(`*${filters.search}*`);
    parts.push(`or=(full_name.ilike.${term},email.ilike.${term},registration_id.ilike.${term})`);
  }
  return `${VIRTUAL_RUN_TABLE}?${parts.join("&")}&select=${COLUMNS}&order=created_at.desc&limit=${filters.limit}`;
}

async function sbGet(env, path) {
  const url = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) { const error = new Error("not configured"); error.status = 503; throw error; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
  try {
    const response = await globalThis.fetch(`${url}/rest/v1/${path}`, {
      signal: controller.signal,
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" }
    });
    if (!response.ok) { const error = new Error(`Supabase ${response.status}`); error.status = response.status; throw error; }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Counts for the summary strip: every registration, whatever the filters, by status and by package. */
export function summarize(rows, cfg = content) {
  const byStatus = Object.fromEntries(PAYMENT_STATUSES.map((status) => [status, 0]));
  const byPackage = Object.fromEntries(cfg.PACKAGES.map((pkg) => [pkg.id, { paid: 0, pending: 0 }]));
  let paidCents = 0;
  for (const row of rows) {
    if (row.payment_status in byStatus) byStatus[row.payment_status] += 1;
    const entry = byPackage[row.package_id];
    if (entry && (row.payment_status === "paid" || row.payment_status === "pending")) entry[row.payment_status] += 1;
    // Test-mode payments are real rows but not real money.
    if (row.payment_status === "paid" && row.livemode === true) paidCents += Number(row.amount_cents) || 0;
  }
  return { total: rows.length, byStatus, byPackage, paidCents };
}

/** The row as the admin page shows it. */
export function adminRow(row) {
  return {
    registrationId: row.registration_id,
    status: row.payment_status,
    packageId: row.package_id,
    package: row.package_name,
    amountCents: row.amount_cents,
    fullName: row.full_name,
    email: row.email,
    mobile: row.mobile,
    dateOfBirth: row.date_of_birth,
    gender: row.gender,
    pb5k: row.pb_5k,
    pb10k: row.pb_10k,
    frequency: row.weekly_frequency,
    goal: row.primary_goal,
    shirtSize: row.shirt_size,
    recipient: row.recipient_name,
    address: row.address_line,
    province: row.province,
    city: row.city,
    barangay: row.barangay,
    postal: row.postal_code,
    paymentMethod: row.payment_method_type,
    livemode: row.livemode,
    paidAt: row.paid_at,
    createdAt: row.created_at,
    resultStatus: row.result_status,
    emailStatus: row.confirmation_email_status
  };
}

/* ---------------------------------------------------------------- handler */

function send(response, status, payload) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  return response.status(status).json(payload);
}

/**
 * GET /api/virtual-run/admin. `authenticate(request)` must return the verified Supabase user for the
 * request's bearer token, or null. (The gateway passes its own requireUser, which asks Supabase Auth.)
 */
export async function adminHandler(request, response, { authenticate, env = process.env, cfg = content } = {}) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return send(response, 405, { error: "Method not allowed." });
  }
  let user = null;
  try {
    user = typeof authenticate === "function" ? await authenticate(request) : null;
  } catch (error) {
    return send(response, 503, { error: "Sign-in could not be checked right now." });
  }
  if (!user || !user.id) return send(response, 401, { error: "Sign in to continue." });
  if (!staffAllowed(user, env)) {
    console.warn(`[virtual-run-admin] refused: user ${String(user.id).slice(0, 8)} is not on a staff list`);
    return send(response, 403, { error: "Not authorized." });
  }

  const filters = parseFilters(request.query, cfg);
  try {
    const rows = await sbGet(env, listQuery(filters, cfg));
    const list = Array.isArray(rows) ? rows : [];
    console.info(`[virtual-run-admin] ${filters.csv ? "export" : "list"} by user ${String(user.id).slice(0, 8)}: ${list.length} rows`);
    if (filters.csv) {
      const stamp = new Date().toISOString().slice(0, 10);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Robots-Tag", "noindex, nofollow");
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="athlevo-sub-1-10k-orders-${stamp}.csv"`);
      return response.status(200).send(buildCsv(list));
    }
    const all = await sbGet(env, `${VIRTUAL_RUN_TABLE}?event=eq.${encodeURIComponent(cfg.EVENT.id)}&select=payment_status,package_id,amount_cents,livemode&limit=${MAX_LIMIT * 2}`);
    return send(response, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      filters: { package: filters.packageId, status: filters.status, q: filters.search, fulfillment: filters.fulfillment },
      truncated: list.length >= filters.limit,
      summary: summarize(Array.isArray(all) ? all : [], cfg),
      rows: list.map(adminRow)
    });
  } catch (error) {
    console.error("[virtual-run-admin] query failed:", error && error.status);
    return send(response, 502, { error: "Registrations could not be loaded." });
  }
}
