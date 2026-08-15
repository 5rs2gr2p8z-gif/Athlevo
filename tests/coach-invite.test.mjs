import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canAcceptInvite,
  generateInviteToken,
  hashInviteToken,
  isInviteExpired,
  normalizeInviteEmail,
  validateInviteEmail,
  validateInviteTransition
} from "../lib/server/coachInvites.js";

const html = readFileSync("./index.html", "utf8");
const client = readFileSync("./js/coachInvites.js", "utf8");
const coachMode = readFileSync("./js/coachMode.js", "utf8");

assert.equal(normalizeInviteEmail("  Athlete@Example.COM "), "athlete@example.com");
assert.equal(validateInviteEmail("athlete@example.com"), true);
assert.equal(validateInviteEmail("not-an-email"), false);

const first = generateInviteToken();
const second = generateInviteToken();
assert.notEqual(first, second);
assert.equal(Buffer.from(first, "base64url").length, 32);
assert.equal(hashInviteToken(first).length, 64);
assert.notEqual(hashInviteToken(first), hashInviteToken(second));

const pending = {
  status: "pending",
  email_normalized: "athlete@example.com",
  expires_at: "2026-08-22T12:00:00.000Z"
};
assert.equal(isInviteExpired(pending, Date.parse("2026-08-20T00:00:00Z")), false);
assert.equal(isInviteExpired(pending, Date.parse("2026-08-23T00:00:00Z")), true);
assert.equal(canAcceptInvite(pending, "ATHLETE@example.com", Date.parse("2026-08-20T00:00:00Z")), true);
assert.equal(canAcceptInvite(pending, "other@example.com", Date.parse("2026-08-20T00:00:00Z")), false);
assert.equal(canAcceptInvite({ ...pending, status: "revoked" }, "athlete@example.com"), false);
assert.equal(canAcceptInvite({ ...pending, status: "accepted" }, "athlete@example.com"), false);
assert.equal(validateInviteTransition("pending", "resend").ok, true);
assert.equal(validateInviteTransition("accepted", "resend").ok, false);

// Startup capture is session-only and strips the credential from history.
assert.match(html, /sessionStorage\.setItem\(KEY, token\)/);
assert.match(html, /url\.searchParams\.delete\("invite"\)/);
assert.doesNotMatch(client, /localStorage/);
assert.match(html, /hasPendingInvite[\s\S]*?showScreen\("screen-welcome"\)/);

// Opening a link only previews; acceptance happens from the explicit button.
assert.match(client, /inviteRequest\(token, "preview"\)/);
assert.match(client, /#ciAcceptInvite[\s\S]*?inviteRequest\(token, "accept"\)/);
assert.match(client, /Sign out and switch account/);
assert.match(client, /This invitation has already been accepted/);
assert.match(client, /This invitation has expired/);
assert.match(client, /AthlevoAthleteMode\.retry/);

// Coach UI stays compact and uses localized mutation states.
assert.match(coachMode, /id="cmInviteAthlete">Invite Athlete/);
assert.match(coachMode, /Pending Invitations/);
assert.match(coachMode, /data-resend-invite/);
assert.match(coachMode, /Revoke invitation\?/);
assert.match(coachMode, /Invitation sent\./);
assert.match(coachMode, /type="email" inputmode="email"/);
assert.match(coachMode, /event\.key !== "Escape"/);

console.log("coach-invite: all assertions passed");
