/*
 * Sub-1 10k Challenge registrations: the staff-only endpoint behind /virtual-run/admin.
 *
 *   GET /api/virtual-run/admin?...               JSON: the registrations that match the filters, plus counts
 *   GET /api/virtual-run/admin?format=csv&...    the same rows as a CSV download (merchandise fulfillment)
 *   GET /api/virtual-run/admin?view=waitlist     the priority list (JSON), or with &format=csv a CSV of it
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
import { WAITLIST_TABLE } from "./virtualRunWaitlist.js";

const DB_TIMEOUT_MS = 8000;
const DEFAULT_LIMIT = 500;
// Supabase answers at most 1000 rows to one request whatever limit is asked for, so a bigger limit would be
// silently cut. The on-screen list stays inside that; the CSV and the counts read page by page instead.
const MAX_LIMIT = 1000;
const PAGE_SIZE = 1000;
const MAX_EXPORT_ROWS = 20000;
export const PAYMENT_STATUSES = Object.freeze(["pending", "paid", "failed", "expired", "cancelled", "refunded"]);

const COLUMNS = [
  "registration_id", "payment_status", "package_id", "package_name", "amount_cents", "full_name", "email", "mobile",
  "date_of_birth", "gender", "pb_5k", "pb_10k", "weekly_frequency", "primary_goal", "shirt_size", "recipient_name",
  "address_line", "province", "city", "barangay", "postal_code", "payment_method_type", "livemode", "paid_at",
  "created_at", "result_status", "confirmation_email_status"
].join(",");
const ORDER = "order=created_at.desc,registration_id.asc";

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

/* ---------------------------------------------------------------- priority list */

const WAITLIST_COLUMNS = "full_name,email,source,status,consent_version,consented_at,created_at,unsubscribed_at,confirmation_email_status";
export const WAITLIST_STATUSES = Object.freeze(["active", "unsubscribed"]);
export const WAITLIST_CSV_HEADERS = Object.freeze(["Full name", "Email", "Status", "Source", "Joined (Manila)", "Consent version"]);

/** The query for priority list rows. `status` is "active", "unsubscribed" or anything else for both. */
export function waitlistQuery(status, cfg = content, page = {}) {
  const parts = [`event=eq.${encodeURIComponent(cfg.EVENT.id)}`];
  if (WAITLIST_STATUSES.includes(status)) parts.push(`status=eq.${status}`);
  const limit = Math.min(PAGE_SIZE, Math.max(1, Number(page.limit) || 200));
  const offset = Math.max(0, Number(page.offset) || 0);
  return `${WAITLIST_TABLE}?${parts.join("&")}&select=${WAITLIST_COLUMNS}&order=created_at.desc,email.asc&limit=${limit}${offset ? `&offset=${offset}` : ""}`;
}

/** The priority list as a CSV (names and emails for writing to people), with the same spreadsheet safety as the orders CSV. */
export function buildWaitlistCsv(rows) {
  const lines = [WAITLIST_CSV_HEADERS.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([row.full_name, row.email, row.status, row.source, manilaStamp(row.created_at), row.consent_version].map(csvCell).join(","));
  }
  return "\ufeff" + lines.join("\r\n") + "\r\n";
}

export function summarizeWaitlist(rows) {
  const summary = { total: rows.length, active: 0, unsubscribed: 0 };
  for (const row of rows) {
    if (row.status === "active") summary.active += 1;
    else if (row.status === "unsubscribed") summary.unsubscribed += 1;
  }
  return summary;
}

/** The row as the staff page shows it. */
export function waitlistRow(row) {
  return {
    fullName: row.full_name, email: row.email, status: row.status, source: row.source || "",
    joinedAt: row.created_at, consentVersion: row.consent_version, emailStatus: row.confirmation_email_status || ""
  };
}

async function waitlistView(request, response, { env, cfg, user }) {
  const q = request.query || {};
  const one = (value) => (Array.isArray(value) ? value[0] : value);
  const csv = String(one(q.format) || "").toLowerCase() === "csv";
  const asked = String(one(q.status) || "");
  // A mailing list should only ever hold people who still want the emails, so the export defaults to them.
  const status = WAITLIST_STATUSES.includes(asked) ? asked : (csv ? "active" : "all");
  try {
    if (csv) {
      const everything = await fetchAllRows(env, (page) => waitlistQuery(status, cfg, page));
      console.info(`[virtual-run-admin] priority list export by user ${String(user.id).slice(0, 8)}: ${everything.rows.length} ${status} rows`);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Robots-Tag", "noindex, nofollow");
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="athlevo-sub-1-10k-priority-list-${status}-${new Date().toISOString().slice(0, 10)}.csv"`);
      if (!everything.complete) response.setHeader("X-Export-Truncated", "1");
      return response.status(200).send(buildWaitlistCsv(everything.rows));
    }
    const latest = await sbGet(env, waitlistQuery(status, cfg, { limit: 200 }));
    const shown = Array.isArray(latest) ? latest : [];
    const all = await fetchAllRows(env, (page) => waitlistQuery("all", cfg, page).replace(`select=${WAITLIST_COLUMNS}`, "select=status"));
    return send(response, 200, {
      ok: true, generatedAt: new Date().toISOString(), summary: summarizeWaitlist(all.rows), summaryComplete: all.complete,
      truncated: shown.length >= 200, rows: shown.map(waitlistRow)
    });
  } catch (error) {
    console.error("[virtual-run-admin] priority list query failed:", error && error.status);
    return send(response, 502, { error: "The priority list could not be loaded." });
  }
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

/** The PostgREST query for these filters. `page` picks a slice: { limit, offset }; it defaults to the on-screen list size. */
export function listQuery(filters, cfg = content, page = {}) {
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
  const limit = Math.min(PAGE_SIZE, Math.max(1, Number(page.limit) || filters.limit));
  const offset = Math.max(0, Number(page.offset) || 0);
  return `${VIRTUAL_RUN_TABLE}?${parts.join("&")}&select=${COLUMNS}&${ORDER}&limit=${limit}${offset ? `&offset=${offset}` : ""}`;
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

/**
 * Reads every row a query matches, one page at a time. Returns { rows, complete }; complete is false when
 * the MAX_EXPORT_ROWS safety stop was reached before the end.
 */
export async function fetchAllRows(env, pathFor, { pageSize = PAGE_SIZE, maxRows = MAX_EXPORT_ROWS } = {}) {
  const rows = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await sbGet(env, pathFor({ limit: pageSize, offset }));
    const batch = Array.isArray(page) ? page : [];
    rows.push(...batch);
    if (batch.length < pageSize) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/**
 * Counts for the summary strip: every registration, whatever the filters, by status and by package.
 * A "pending" row whose hold has run out no longer holds a spot, so it is counted as a lapsed hold, not as pending.
 */
export function summarize(rows, cfg = content, now = new Date()) {
  const byStatus = Object.fromEntries(PAYMENT_STATUSES.map((status) => [status, 0]));
  const byPackage = Object.fromEntries(cfg.PACKAGES.map((pkg) => [pkg.id, { paid: 0, pending: 0 }]));
  let paidCents = 0;
  let lapsed = 0;
  for (const row of rows) {
    let status = row.payment_status;
    if (status === "pending" && row.hold_expires_at && Date.parse(row.hold_expires_at) <= now.getTime()) {
      lapsed += 1;
      status = "lapsed";
    }
    if (status in byStatus) byStatus[status] += 1;
    const entry = byPackage[row.package_id];
    if (entry && (status === "paid" || status === "pending")) entry[status] += 1;
    // Test-mode payments are real rows but not real money.
    if (status === "paid" && row.livemode === true) paidCents += Number(row.amount_cents) || 0;
  }
  return { total: rows.length, byStatus, byPackage, paidCents, lapsedHolds: lapsed };
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

  const view = Array.isArray((request.query || {}).view) ? request.query.view[0] : (request.query || {}).view;
  if (view === "waitlist") return waitlistView(request, response, { env, cfg, user });

  const filters = parseFilters(request.query, cfg);
  try {
    if (filters.csv) {
      // The export is every matching row, however many there are, read page by page.
      const everything = await fetchAllRows(env, (page) => listQuery(filters, cfg, page));
      console.info(`[virtual-run-admin] export by user ${String(user.id).slice(0, 8)}: ${everything.rows.length} rows${everything.complete ? "" : " (stopped at the safety limit)"}`);
      const stamp = new Date().toISOString().slice(0, 10);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Robots-Tag", "noindex, nofollow");
      response.setHeader("Content-Type", "text/csv; charset=utf-8");
      response.setHeader("Content-Disposition", `attachment; filename="athlevo-sub-1-10k-orders-${stamp}.csv"`);
      if (!everything.complete) response.setHeader("X-Export-Truncated", "1");
      return response.status(200).send(buildCsv(everything.rows));
    }
    const rows = await sbGet(env, listQuery(filters, cfg));
    const list = Array.isArray(rows) ? rows : [];
    console.info(`[virtual-run-admin] list by user ${String(user.id).slice(0, 8)}: ${list.length} rows`);
    const all = await fetchAllRows(env, (page) =>
      `${VIRTUAL_RUN_TABLE}?event=eq.${encodeURIComponent(cfg.EVENT.id)}` +
      `&select=payment_status,package_id,amount_cents,livemode,hold_expires_at&order=created_at.desc,registration_id.asc` +
      `&limit=${page.limit}${page.offset ? `&offset=${page.offset}` : ""}`);
    return send(response, 200, {
      ok: true,
      generatedAt: new Date().toISOString(),
      filters: { package: filters.packageId, status: filters.status, q: filters.search, fulfillment: filters.fulfillment },
      truncated: list.length >= filters.limit,
      summaryComplete: all.complete,
      summary: summarize(all.rows, cfg),
      rows: list.map(adminRow)
    });
  } catch (error) {
    console.error("[virtual-run-admin] query failed:", error && error.status);
    return send(response, 502, { error: "Registrations could not be loaded." });
  }
}
