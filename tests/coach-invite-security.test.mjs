import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canManageOwnCoachInvites, canManageAssignments } from "../lib/server/coachRoles.js";

const api = readFileSync("./api/providers/index.js", "utf8");
const migration = readFileSync("./migrations/2026-08-15_coach_athlete_invites.sql", "utf8");

assert.equal(canManageOwnCoachInvites({ role: "athlete" }), false);
assert.equal(canManageOwnCoachInvites({ role: "coach" }), true);
assert.equal(canManageOwnCoachInvites({ role: "admin" }), true);
assert.equal(canManageAssignments({ role: "coach" }), false);

// Default-deny browser access: RLS is enabled and no table policy is created.
assert.match(migration, /alter table public\.coach_athlete_invites enable row level security/i);
assert.doesNotMatch(migration, /create policy[\s\S]{0,160}coach_athlete_invites/i);
assert.match(migration, /revoke all on function public\.athlevo_accept_coach_invite[\s\S]*from public, anon, authenticated/i);

// Database stores only a unique SHA-256 hash, never a raw-token column.
assert.match(migration, /token_hash\s+text not null/i);
assert.doesNotMatch(migration, /raw_token|invite_token\s+text/i);
assert.match(api, /token_hash: hashInviteToken\(rawToken\)/);

// Invite management is scoped to the authenticated coach, never body.coach_id.
assert.match(api, /coach_id: actor\.user\.id/);
assert.match(api, /coach_id=eq\.\$\{enc\(actor\.user\.id\)\}/);
assert.doesNotMatch(api, /body\.coach_id/);

// The list selects safe metadata and never selects/returns token_hash.
const listAction = api.slice(api.indexOf("async function actionCoachingInviteList"), api.indexOf("async function actionCoachingInviteResend"));
assert.match(listAction, /coach_id=eq\.\$\{enc\(actor\.user\.id\)\}/);
assert.doesNotMatch(listAction, /token_hash/);

// Accept is atomic, derives both principals authoritatively, and creates only active.
assert.match(migration, /for update/i);
assert.match(migration, /v_invite\.coach_id, p_athlete_id, 'active'/i);
assert.match(migration, /created_by[\s\S]*v_invite\.coach_id/i);
assert.match(migration, /status = 'accepted'[\s\S]*accepted_by = p_athlete_id/i);
assert.match(api, /p_athlete_id: actor\.user\.id/);
assert.match(api, /p_email_normalized: authenticatedEmail/);
assert.doesNotMatch(api.slice(api.indexOf("async function actionCoachingInviteAccept"), api.indexOf("async function actionCoachingDashboardRoster")), /body\.athlete_id|body\.coach_id/);

// Resend replaces the hash before delivery, immediately invalidating the old link.
const resend = api.slice(api.indexOf("async function actionCoachingInviteResend"), api.indexOf("async function actionCoachingInviteRevoke"));
assert.match(resend, /token_hash: hashInviteToken\(rawToken\)/);
assert.ok(resend.indexOf("sbCoachWrite") < resend.indexOf("sendCoachInviteEmail"));

// Pending/expired/revoked/wrong-email paths all return before assignment insert.
const insertAt = migration.indexOf("insert into public.coach_athlete_assignments");
for (const guard of ["status = 'revoked'", "expires_at <= now()", "<> v_invite.email_normalized"]) {
  assert.ok(migration.indexOf(guard) > -1 && migration.indexOf(guard) < insertAt, guard);
}

console.log("coach-invite-security: all assertions passed");
