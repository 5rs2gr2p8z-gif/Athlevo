/*
 * The Sub-1 10k Challenge priority list: people who want to hear first when registration opens.
 *
 *   POST /api/virtual-run/waitlist   { fullName, email, consent: true, source? }   join
 *                                    { leave: "<token from the e-mail>" }           leave
 *
 * What it keeps, and why that is all it keeps:
 *   - Name and email, because that is what it takes to write to someone. Nothing else about the person.
 *   - The consent wording's version and the time it was given, so consent can be shown later.
 *   - An optional short source label (the campaign link they came from), for the owner's marketing numbers.
 *   - A secret leave token, so every e-mail can carry a link that removes the person without a login.
 * It stores no IP address and no browser details. The table is behind row level security with no policies,
 * so only the server (service role) and the protected staff page can read it.
 *
 * Joining twice does not make two rows and does not say whether an address is already on the list: the answer
 * is the same either way. Someone who left and joins again has agreed again, so they are put back.
 * The confirmation e-mail is best effort: if it cannot be sent, the person is still on the list.
 * Nothing on this list involves payment, and it works whether or not registration is open.
 */

import crypto from "node:crypto";
import * as content from "../../content/virtualRun.mjs";
import { checkAnonymousAiRateLimit, rateLimitResponse } from "./rateLimit.js";
import { sendEmail, validEmail } from "./signupNotifications.js";
import { P, SMALL, WRAP_CLOSE, WRAP_OPEN, escapeHtml } from "./virtualRunPayments.js";
import { HONEYPOT_FIELD, asText, clientKey, line, readJsonBody, send, siteUrl, supabase, waitlistOpen } from "./virtualRun.js";

export const WAITLIST_TABLE = "virtual_run_waitlist";
export const WAITLIST_SCOPE = "virtual-run-waitlist";
export const LEAVE_TOKEN_PATTERN = /^ATH-WL-[0-9A-F]{32}$/;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
// A link or an address in the name box is a bot, not a runner.
const SPAMMY_NAME = /(https?:|www\.|@|\.(com|net|org|ru|xyz|top|info)\b)/i;

export function newLeaveToken() {
  return "ATH-WL-" + crypto.randomBytes(16).toString("hex").toUpperCase();
}

/** The sign-up checked on the server. The browser's own checks are a courtesy; these are the ones that count. */
export function validateWaitlist(body) {
  const input = body && typeof body === "object" ? body : {};
  const fields = {};
  const value = {};
  value.fullName = line(asText(input.fullName), 120);
  if (value.fullName.length < 2 || SPAMMY_NAME.test(value.fullName)) fields.fullName = "fullName";
  const email = validEmail(asText(input.email));
  if (!email) fields.email = "email"; else value.email = email;
  // Consent is the plain boolean true. A string, a number or a missing value is not consent.
  if (input.consent !== true) fields.consent = "consent";
  const source = line(asText(input.source), 40).toLowerCase();
  value.source = SOURCE_PATTERN.test(source) ? source : null;
  return { ok: Object.keys(fields).length === 0, fields, value };
}

/** The confirmation e-mail, with the link that removes the person from the list. Null when there is no address. */
export function waitlistEmail(row, { cfg = content, env = process.env } = {}) {
  const to = validEmail(row && row.email);
  if (!to) return null;
  const W = cfg.WAITLIST_EMAIL;
  const first = line(row.full_name, 60).split(" ")[0] || "";
  const leaveUrl = `${siteUrl(env)}${cfg.SITE.path}?leave=${encodeURIComponent(row.unsubscribe_token)}`;
  const next = W.next + (cfg.EVENT.datesConfirmed ? "" : " " + W.datesPending);
  const replyTo = validEmail(env.SIGNUP_REPLY_TO_EMAIL) || cfg.SITE.supportEmail;
  const html = WRAP_OPEN +
    `<p ${P}>${first ? `Hi ${escapeHtml(first)}, ` : ""}${escapeHtml(W.intro)}</p>` +
    `<p ${P}>${escapeHtml(next)}</p>` +
    `<p ${SMALL}>${escapeHtml(W.why)}</p>` +
    `<p ${SMALL}>${escapeHtml(W.leaveLine)} <a href="${escapeHtml(leaveUrl)}" style="color:#6d7075">${escapeHtml(leaveUrl)}</a></p>` +
    `<p ${SMALL}>Questions? Reply to this email or write to ${escapeHtml(replyTo)}.</p>` +
    WRAP_CLOSE;
  const text = [
    `${first ? `Hi ${first}, ` : ""}${W.intro}`, "", next, "", W.why, "", `${W.leaveLine} ${leaveUrl}`, "",
    `Questions? Reply to this email or write to ${replyTo}.`
  ].join("\n");
  return { to: [to], reply_to: replyTo, subject: W.subject, html, text };
}

function sourceHint(error) {
  return error && error.status === 404 ? ` (run migrations/2026-11-14_virtual_run_waitlist.sql)` : "";
}

async function noteEmail(db, row, outcome, now) {
  try {
    if (outcome !== "sent" && outcome !== "failed") return;
    await db.rest(`${WAITLIST_TABLE}?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: { confirmation_email_status: outcome, updated_at: now.toISOString() }
    });
  } catch (error) {
    console.error("[virtual-run] could not note the priority list e-mail outcome:", error && error.status);
  }
}

async function join(db, value, { env, now, cfg, email }) {
  const event = encodeURIComponent(cfg.EVENT.id);
  const found = await db.rest(
    `${WAITLIST_TABLE}?event=eq.${event}&email=eq.${encodeURIComponent(value.email)}&select=id,status,unsubscribe_token,full_name&limit=1`);
  const existing = Array.isArray(found.data) ? found.data[0] : null;
  const stamp = now.toISOString();
  let row = null;
  if (!existing) {
    row = {
      id: crypto.randomUUID(), event: cfg.EVENT.id, full_name: value.fullName, email: value.email,
      consent_version: cfg.WAITLIST.consentVersion, consented_at: stamp, source: value.source,
      unsubscribe_token: newLeaveToken(), status: "active", created_at: stamp, updated_at: stamp
    };
    try {
      await db.rest(WAITLIST_TABLE, { method: "POST", body: row, prefer: "return=minimal" });
    } catch (error) {
      // Two sign-ups for one address at the same moment: the other one won, which is the same outcome.
      if (error && error.status === 409) return { sendWelcome: false };
      throw error;
    }
  } else if (existing.status === "unsubscribed") {
    // They left, and now they have agreed again.
    await db.rest(`${WAITLIST_TABLE}?id=eq.${encodeURIComponent(existing.id)}`, {
      method: "PATCH", prefer: "return=minimal",
      body: {
        status: "active", unsubscribed_at: null, full_name: value.fullName, consent_version: cfg.WAITLIST.consentVersion,
        consented_at: stamp, source: value.source, updated_at: stamp
      }
    });
    row = { ...existing, full_name: value.fullName, email: value.email };
  } else {
    return { sendWelcome: false };
  }
  const message = waitlistEmail(row, { cfg, env });
  if (!message) return { sendWelcome: false };
  const outcome = await email(message, { env, idempotencyKey: `virtual-run-waitlist-${row.id}-${Date.parse(stamp)}` }).catch(() => "failed");
  await noteEmail(db, row, outcome, now);
  return { sendWelcome: true, outcome };
}

async function leave(db, token, { now }) {
  await db.rest(`${WAITLIST_TABLE}?unsubscribe_token=eq.${encodeURIComponent(token)}&status=eq.active`, {
    method: "PATCH", prefer: "return=minimal",
    body: { status: "unsubscribed", unsubscribed_at: now.toISOString(), updated_at: now.toISOString() }
  });
}

export async function waitlistHandler(request, response, { env = process.env, now = new Date(), cfg = content, email = sendEmail } = {}) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return send(response, 405, { error: "Method not allowed." });
  }
  const body = readJsonBody(request);
  if (!body || typeof body !== "object") return send(response, 400, { error: "invalid", fields: {} });

  // A hidden field people never see. If it is filled, a bot did it: look successful, save nothing.
  const trap = body[HONEYPOT_FIELD];
  if (trap !== undefined && trap !== null && trap !== false && line(asText(trap), 200)) return send(response, 200, { ok: true });

  if (!waitlistOpen({ env, cfg })) return send(response, 503, { error: "unavailable" });

  const limit = await checkAnonymousAiRateLimit(clientKey(request, WAITLIST_SCOPE), WAITLIST_SCOPE);
  if (!limit.allowed) return rateLimitResponse(response, limit);

  const db = supabase(env);
  if (!db) return send(response, 503, { error: "unavailable" });

  if (body.leave !== undefined) {
    const token = line(asText(body.leave), 60).toUpperCase();
    // A token that is not shaped like ours cannot belong to anyone; answer the same as a real one.
    if (LEAVE_TOKEN_PATTERN.test(token)) {
      try {
        await leave(db, token, { now });
      } catch (error) {
        console.error(`[virtual-run] could not remove someone from the priority list, database status ${error && error.status}${sourceHint(error)}`);
        return send(response, 503, { error: "unavailable" });
      }
    }
    return send(response, 200, { ok: true });
  }

  const checked = validateWaitlist(body);
  if (!checked.ok) return send(response, 400, { error: "invalid", fields: checked.fields });

  try {
    await join(db, checked.value, { env, now, cfg, email });
  } catch (error) {
    console.error(`[virtual-run] priority list sign-up not saved, database status ${error && error.status}${sourceHint(error)}`);
    return send(response, 503, { error: "unavailable" });
  }
  return send(response, 200, { ok: true });
}
