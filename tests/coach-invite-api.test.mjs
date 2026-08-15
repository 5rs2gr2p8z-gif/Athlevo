import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const api = readFileSync("./api/providers/index.js", "utf8");
const migration = readFileSync("./migrations/2026-08-15_coach_athlete_invites.sql", "utf8");

for (const action of ["create", "list", "accept", "resend", "revoke"]) {
  assert.match(api, new RegExp(`action === "coaching_invite_${action}"`));
}

const create = api.slice(api.indexOf("async function actionCoachingInviteCreate"), api.indexOf("async function actionCoachingInviteList"));
assert.match(create, /canManageOwnCoachInvites\(actor\.profile\)/);
assert.match(create, /normalizeInviteEmail\(body\.email\)/);
assert.match(create, /normalizeInviteEmail\(actor\.user\.email\) === email/);
assert.match(create, /INVITE_ALREADY_PENDING/);
assert.match(create, /ATHLETE_ALREADY_ON_ROSTER/);
assert.match(create, /permission_level: "read_write"/);
assert.match(create, /INVITE_TTL_MS/);
assert.ok(create.indexOf("coach_athlete_invites") < create.indexOf("sendCoachInviteEmail"));

const accept = api.slice(api.indexOf("async function actionCoachingInviteAccept"), api.indexOf("async function actionCoachingDashboardRoster"));
assert.match(accept, /authenticatedEmail !== invite\.email_normalized/);
assert.match(accept, /intent === "preview"/);
assert.match(accept, /intent !== "accept"/);
assert.match(accept, /athlevo_accept_coach_invite/);
assert.match(accept, /already_accepted/);

assert.match(api, /process\.env\.RESEND_API_KEY/);
assert.match(api, /process\.env\.ATHLEVO_INVITE_FROM_EMAIL/);
assert.match(api, /Athlevo <noreply@athlevo\.org>/);
assert.match(api, /reply_to: "support@athlevo\.org"/);
assert.match(api, /INVITE_EMAIL_SETUP_REQUIRED/);
assert.match(api, /https:\/\/api\.resend\.com\/emails/);

assert.match(migration, /where status = 'pending'/i);
assert.match(migration, /unique index[\s\S]*coach_id, email_normalized/i);
assert.match(migration, /permission_level[\s\S]*read_write/i);
assert.match(migration, /status[\s\S]*pending[\s\S]*accepted[\s\S]*expired[\s\S]*revoked/i);

console.log("coach-invite-api: all assertions passed");
