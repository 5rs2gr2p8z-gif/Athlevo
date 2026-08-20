# Athlevo — Coach Dashboard MVP Foundation (Sprint Report)

**Date:** 2026-08-01
**Scope:** Foundation for coaches to run their existing clients on Athlevo — roles, assignments, RLS, dashboard route, roster, attention queue, athlete overview. **Not** a TrainingPeaks replacement; no plan editing, no messaging, no payments, no advanced coach AI.
**Status:** Implemented and tested. **Not committed / pushed / deployed. No SQL applied. No production data modified.**

## 1. Current architecture found

Supabase Auth (`auth.users`); every API validates the bearer token via `GET /auth/v1/user` (service-role `apikey`) then uses the service-role key **server-side only** — no service-role key exists in any browser file (verified). `profiles` (created outside migrations) holds `full_name, primary_sport, goal, target_race, target_race_date, race_type, experience_level, email, id` — **no avatar, no role column**. There was **no human-coach identity**: "coach" in the code (`coach_conversations`, `coach_action_proposals`, `api/coach.js`) is the AI coach keyed by the athlete's own `user_id`. Only admin gating was an `ADMIN_USER_IDS` env allowlist in `api/providers/index.js`. Every athlete table enforces strict per-user RLS (`auth.uid() = user_id`), so authenticated users cannot read each other's data — meaning a coach must read through a server endpoint authorized by role + active assignment. Data available for the dashboard: `athlete_metrics` (7-day load, fatigue/fitness, last_updated), `weekly_progress_summaries` (planned vs completed, recovery/consistency/injury-risk/trajectory), `daily_readiness` (pain, sleep, energy, soreness, stress), `training_sessions` (plan/today), `activities`, `provider_accounts.last_sync_at`. Routing is a SPA using `showScreen('screen-*')` with a bottom-nav TAB map. Provider tokens live in `provider_accounts/strava_accounts/terra_accounts`; payments in `subscriptions`.

## 2. Role model

`profiles.role` — server-authoritative, default `'athlete'`, `check in ('athlete','coach','admin')`. Roles are **never inferred from email**. `lib/server/coachRoles.js` (pure): `resolveRole` (unknown → athlete), `canAccessCoachDashboard` (coach/admin), `canManageAssignments` (admin only). The API re-derives the role from the caller's **own** `profiles` row on every request; the browser is never the security boundary.

## 3. Assignment model

`coach_athlete_assignments (id, coach_id, athlete_id, status, permission_level, created_by, assigned_at, ended_at, created_at, updated_at)`; statuses `invited|active|paused|ended`; only `active` grants access. A partial unique index (`coach_id, athlete_id) where status in ('invited','active','paused')` prevents duplicate live assignments while keeping `ended` rows for audit; `check (coach_id <> athlete_id)` blocks self-assignment. `lib/server/coachAssignments.js` (pure) provides `activeAssignmentsForCoach`, `assignedAthleteIds`, `canCoachAccessAthlete`, `wouldDuplicateLiveAssignment`, `validateNewAssignment`. Assignments are created/mutated **only** via the service role (admin/bootstrap path) — there is no client insert/update/delete policy, so athletes can't self-assign and coaches can't claim arbitrary athletes.

## 4. RLS / security behavior

Defense in depth. `public.athlevo_is_active_coach_of(athlete)` (SECURITY DEFINER, STABLE) returns true only when an **active** assignment links `auth.uid()` → athlete. Coach **SELECT-only** policies gated on that predicate are added to `profiles, activities, daily_readiness, athlete_metrics, workout_execution_records, weekly_progress_summaries, training_sessions`. `provider_accounts, strava_accounts, terra_accounts, subscriptions, subscription_events, pending_provider_connections` deliberately get **no** coach policy — tokens and payment data are never exposed to a coach token. Coaches get no insert/update/delete on athlete data, so they can't alter an athlete's identity or plan. The API is the second gate: it authorizes any client-supplied `athlete_id` against the caller's active assignments **before** loading data, never SELECTs `access_token/refresh_token`, and never leaks raw DB errors. Existing per-user athlete policies are unchanged.

## 5. Dashboard route

`/api/coach-dashboard` (named to avoid colliding with the AI-coach `api/coach.js`) with actions `roster` (GET), `athlete` (GET), `review` (POST). Client: `js/coachDashboard.js` (`window.AthlevoCoachDashboard`) renders a separate `screen-coach` workspace via hash route `#coach` (PWA/back/refresh safe). `init()` is a **no-op for athletes** — it injects no entry and registers no route unless the caller's own `profiles.role` is coach/admin; a Coach entry button is injected into the You screen for coach/admin only, and forcing `#coach` as an athlete redirects to Today. Athlete bottom nav is untouched.

## 6. Roster fields

Per assigned athlete (sanitized): name, initials (no email), canonical primary sport, goal, target event + date, today's planned workout, latest completed activity (sport-aware), readiness status label, recovery status, 7-day load, plan adherence %, last-active, attention status/severity/reason-keys, and an `unread_count: null` messaging placeholder. States: **Needs attention · Monitor · No recent data · On track**, sorted needs-attention → monitor → no-recent-data → on-track (then severity, then name). Client-side name search. Missing metrics render `—` / "No recent data" — never fabricated zeroes.

## 7. Attention rules

`lib/server/attentionClassifier.js` — one deterministic, explainable, UI-independent classifier returning `{status, severity, reasons:[{key,severity,explanation,date}]}`. High: `pain_reported`, `illness_reported`, `very_low_readiness`, `missed_key_workout`. Medium: `low_recovery`, `multiple_missed_sessions`, `high_recent_load`, `provider_sync_failed`, `no_active_plan`, `no_recent_activity`. Low/informational: `no_readiness_checkin`, `no_recent_app_activity`, `event_approaching`. No data at all → `no_recent_data` (a state, not an alarm). Thresholds are documented and overridable for deterministic tests. **Coaching language only** ("Pain was reported in the latest check-in"), never medical diagnosis, and it never labels an athlete healthy/injured/cleared. "Mark reviewed" upserts `coach_attention_reviews (coach_id, athlete_id, alert_key, reviewed_at)` — one current row per triple (not per render), preserving an audit trail; reviewing does **not** clear the underlying condition (the classifier reads athlete data, not reviews).

## 8. Athlete overview

`buildAthleteOverview` (sanitized): identity + goal, canonical primary sport, event date, plan phase, today's workout, week planned-vs-completed, latest readiness (+pain flag) and recovery, recent activities **sport-aware** (run → pace/distance; ride → speed/power/cadence + data-quality; strength → duration/category) reusing the multisport foundation, active attention reasons, last sync, last active. No plan editing. Provider tokens/emails/account IDs are never included (guarded by `findSensitiveKeys`, tested).

## 9. Migrations created but NOT applied

- `migrations/2026-08-01_coach_dashboard.sql` — role column, `coach_athlete_assignments`, `coach_attention_reviews`, indexes, the `athlevo_is_active_coach_of` predicate, and coach-read RLS. Additive; preserves data; grants nobody coach/admin.
- `migrations/coach_bootstrap_example.sql` — reviewed **manual** SQL (placeholder UUIDs only) to promote an account, assign one athlete, verify, and revoke.

Both are manual-run only. No SQL was executed.

## 10. Bootstrap / testing procedure

Apply `2026-08-01_coach_dashboard.sql` in Supabase, then run the bootstrap steps: (1) `UPDATE profiles SET role='coach' WHERE id=<your uuid>`; (2) insert one `active` assignment to a test athlete; (3) verify via the join query and `SELECT athlevo_is_active_coach_of(<athlete>)` as the coach; (4) revoke with `status='ended', ended_at=now()` (immediately removes access, keeps history). No production account is promoted automatically; no real UUIDs are committed. Local/CI testing needs no DB — `tests/coach-dashboard.test.mjs` drives the pure logic with fixtures.

## 11. Files changed

**New (9):** `lib/server/coachRoles.js`, `lib/server/coachAssignments.js`, `lib/server/attentionClassifier.js`, `lib/server/coachSanitize.js`, `api/coach-dashboard.js`, `js/coachDashboard.js`, `migrations/2026-08-01_coach_dashboard.sql`, `migrations/coach_bootstrap_example.sql`, `tests/coach-dashboard.test.mjs`.

**Modified (2):** `index.html` (2 script tags + a guarded, non-blocking `AthlevoCoachDashboard.init()` on the authenticated boot path), `js/analyticsRegistry.js` (4 categorical coach events).

## 12. Tests and failures

- **`tests/coach-dashboard.test.mjs`: 74 passed, 0 failed** — role security (incl. client-spoof resistance via source assertion), assignments (active/ended/paused/duplicate/self-assign/cross-coach), RLS/API (service-role absent from bundle, athlete_id can't bypass, tokens never selected/returned, migration policy shape), roster (fields, sort, search, unavailable states, sport units), attention (pain/illness/low-readiness/missed/no-data/on-track/coaching-language/review-traceability/condition-persistence), overview (sport-aware, unassigned blocked, no leaks), analytics privacy.
- **Broad suite:** the failing set is exactly the 6 pre-existing design-system failures (`consistency-pass`, `layout-system`, `paywall`, `training-data-ux`, `typography`, `ux-polish` — identical at clean HEAD) plus `coach-limit`'s single `dist/js/analyticsRegistry.js === src` assertion (gitignored `dist/` is stale after the registry edit; resolves on the standard host `npm run build:native`). **No new regressions.** `analytics` (85), `service-worker-cache` (18), `connect-click` (71), `security-isolation` (113), provider/plan/today/trends/readiness suites all pass.
- `node --check` passes on all new/changed JS; `git diff --check` is clean.

## 13. Remaining MVP gaps

No plan editing or coach↔athlete messaging (out of scope). Attention inputs use `weekly_progress_summaries`/`daily_readiness`/metrics; `missed_key_workout`/`missedSessionCount` are wired in the classifier but the endpoint currently derives them conservatively (it does not yet run full planned-vs-executed matching per session — a fast follow). No coach-initiated invitations UI (assignments are admin/service-role only this sprint). No pagination for very large rosters. `illness_reported` depends on a future explicit check-in field (no such field exists yet, so it never fires from current data). RLS policies are drafted and unit-asserted but not exercised against a live database in this environment.

## 14. Whether safe to commit

**Yes — safe to commit**, with one coordination note: `index.html` and `js/analyticsRegistry.js` also contain the **prior multi-sport sprint's** uncommitted additive edits (both sprints touch these two files). Commit the multi-sport sprint first (its documented 14-file scope), then this sprint. All coach changes are additive: no schema applied, no data mutated, the athlete app path is unchanged (init is a no-op for athletes), and no service-role key is shipped to the browser. The only broad-suite "failure" touching this diff is the gitignored `dist/` parity check, resolved by the existing pre-deploy build step.

## 15. Recommended next Coach Dashboard sprint

Coach-initiated athlete **invitations + acceptance** flow (replacing service-role-only assignment); full **planned-vs-executed** session matching to power `missed_key_workout`/adherence precisely; a **notes** surface (coach-private, RLS-isolated from athletes); read-only **plan view** then guarded plan adjustment; roster **pagination + server-side filter**; an **admin roles/assignments** management screen; and live **RLS integration tests** against a Supabase preview branch (attempting cross-athlete and ended-assignment reads with real tokens).

*Not committed, pushed, deployed, or applied by this session.*
