# Athlevo Security Matrix — Phase 1 Read-Only Inventory

**Generated:** 2026-07-26  
**Scope:** All tables, API routes, secrets, rate limits, storage  
**Method:** Static code analysis of migrations/, api/, lib/, js/

---

## 1. Database Table Security

### Tables WITH RLS enabled + user-scoped policies (migration-verified)

| Table | RLS | Policies | Ownership column | Migration |
|---|---|---|---|---|
| beta_feedback | YES | SELECT, INSERT own | user_id | 2026-07-13_beta_feedback |
| weekly_check_ins | YES | SELECT, INSERT, UPDATE own | user_id | 2026-07-13_weekly_adaptive_loop |
| weekly_progress_summaries | YES | SELECT own | user_id | 2026-07-13_weekly_adaptive_loop |
| workout_execution_records | YES | SELECT, INSERT, UPDATE, DELETE own | user_id | 2026-07-13_workout_execution_records |
| athlete_memory | YES | SELECT, INSERT, UPDATE, DELETE own | user_id | 2026-07-14_athlete_memory_upgrade |
| coach_conversations | YES | SELECT, INSERT, DELETE own | user_id | 2026-07-14_athlete_memory_upgrade |
| coach_action_proposals | YES | SELECT, INSERT, UPDATE own | user_id | 2026-07-14_coach_actions |
| activity_data_overrides | YES | SELECT, INSERT, UPDATE own | user_id | 2026-07-14_coach_actions |
| daily_readiness | YES | SELECT, INSERT, UPDATE own | user_id | 2026-07-14_daily_readiness |
| subscription_plans | YES | SELECT (any authenticated) | — | 2026-07-14_subscriptions |
| subscriptions | YES | SELECT own | user_id | 2026-07-14_subscriptions |
| subscription_events | YES | SELECT own | user_id | 2026-07-14_subscriptions |
| athlete_metrics | YES | SELECT, INSERT, UPDATE, DELETE own | user_id | 2026-07-15_athlete_metrics |
| athlevo_score_history | YES | SELECT, INSERT, UPDATE, DELETE own | user_id | 2026-07-15_athlevo_score_history |
| pace_feedback | YES | SELECT, INSERT, UPDATE own | user_id | 2026-07-15_pace_feedback |
| race_results | YES | SELECT, INSERT, UPDATE, DELETE own | user_id | 2026-07-15_race_results |
| activation_events | YES | SELECT, INSERT own | user_id | 2026-07-20_activation_events |
| ai_rate_limits | YES | No user policies (service-role only) | user_id | 2026-07-20_ai_rate_limits |

### Tables WITH RLS enabled but NO user policies (server-only access)

| Table | RLS | Policies | Risk | Migration |
|---|---|---|---|---|
| provider_accounts | YES | None (service-role only) | LOW — tokens inaccessible from client | 2026-07-20_provider_accounts |
| pending_provider_connections | YES | None (service-role only) | LOW — encrypted, consumed atomically | 2026-07-21_pending_provider_connections |

### Tables WITHOUT RLS in any migration — CRITICAL

| Table | Has user_id? | Client-accessible? | Risk | Notes |
|---|---|---|---|---|
| **profiles** | id (= auth.uid) | YES — js/brain.js queries it | **CRITICAL** — any authenticated user could read all profiles | Pre-dates migration directory |
| **activities** | user_id | YES — js/brain.js queries it | **CRITICAL** — workout data of all users readable | Pre-dates migration directory |
| **training_plans** | user_id | YES — js/productionVerify.js | **CRITICAL** — AI-generated plans readable | Pre-dates migration directory |
| **training_sessions** | user_id | YES — js/athleteModel.js | **CRITICAL** — daily session data readable | Pre-dates migration directory |
| **strava_accounts** | user_id | YES — js/brain.js queries it | **CRITICAL** — contains OAuth tokens | Only constraints migration exists |

**Note:** These tables may have RLS enabled via the Supabase dashboard. This must be verified against production before applying the remediation migration. If RLS is already on, the migration's `enable row level security` is a no-op and safe to run. If RLS is off, this is the top-priority fix.

---

## 2. API Route Authorization Matrix

| Endpoint | Auth | User identity source | Ownership check | Rate limit | Subscription gate |
|---|---|---|---|---|---|
| api/coach.js | Bearer→Supabase | JWT (auth/v1/user) | user_id from JWT | 40/hr | coach_chat |
| api/daily-brief.js | Bearer→Supabase | JWT | user_id from JWT | 30/hr | daily_brief |
| api/memory/extract.js | Bearer→Supabase | JWT | user_id from JWT | **NONE** | conversation_memory |
| api/training/generate-plan.js | Bearer→Supabase | JWT | user_id from JWT | **NONE** | next_week_generation |
| api/training/weekly-analysis.js | Bearer→Supabase | JWT | user_id from JWT | **NONE** | weekly_analysis |
| api/training/get-week.js | Bearer→Supabase | JWT | user_id from JWT | N/A (read) | train_tab |
| api/training/check-in.js | Bearer→Supabase | JWT | user_id from JWT | N/A (write) | morning_checkin |
| api/strava/connect.js | Bearer→Supabase | JWT | user_id from JWT | N/A | strava_sync |
| api/strava/callback.js | HMAC state | Signed state param | State verification | N/A | — |
| api/strava/sync.js | Bearer→Supabase | JWT | user_id from JWT | N/A | strava_sync |
| api/providers/index.js | Bearer→Supabase | JWT (requireUser) | user_id from JWT | N/A | — |
| api/whop/webhook.js | Webhook HMAC | N/A (server→server) | N/A | N/A | — |

### Critical gaps

- **generate-plan**: Most expensive AI call (maxDuration=60s, full GPT-5.5 plan generation). No rate limit. A user could trigger unlimited $0.50+ calls.
- **weekly-analysis**: Full GPT-5.5 analysis. No rate limit.
- **memory/extract**: GPT-5.5 memory extraction. No rate limit. Config exists in rateLimit.js (`"memory-extract": 60/60min`) but is never imported or called.
- **No daily aggregate cap**: Hourly limits on coach/daily-brief don't prevent sustained abuse (40/hr × 24hr = 960 coach calls/day).

---

## 3. Secrets and Frontend Exposure

| Value | Location | Type | Risk |
|---|---|---|---|
| SUPABASE_URL | index.html line 4363 | Public | SAFE — designed to be public |
| SUPABASE_ANON_KEY | index.html line 4364 | Publishable | SAFE — RLS is the security layer |
| PostHog API key | index.html meta tag | Public | SAFE — public analytics token |
| OPENAI_API_KEY | process.env (server only) | Secret | SAFE — never in frontend |
| SUPABASE_SERVICE_ROLE_KEY | process.env (server only) | Secret | SAFE — never in frontend |
| WHOP_WEBHOOK_SECRET | process.env (server only) | Secret | SAFE — never in frontend |
| WHOP_API_KEY | process.env (server only) | Secret | SAFE — never in frontend |
| HMAC_STATE_SECRET | process.env (server only) | Secret | SAFE — never in frontend |
| AES_PENDING_KEY | process.env (server only) | Secret | SAFE — never in frontend |
| No .env files in repo | Verified via find | — | SAFE |

---

## 4. Rate Limiting Architecture

**Current implementation:** Postgres-backed fixed window (ai_rate_limits table).

| Concern | Status |
|---|---|
| Atomic increment | **VULNERABLE** — read-then-increment race condition |
| Endpoints covered | Only coach (40/hr) and daily-brief (30/hr) |
| Daily aggregate cap | **MISSING** |
| Cost exposure | generate-plan + weekly-analysis + memory-extract = unlimited AI spend |

---

## 5. Webhook Security

| Check | Status |
|---|---|
| HMAC signature verification | PASS — Standard Webhooks spec |
| Replay protection | PASS — 5-minute timestamp window |
| Idempotent processing | PASS — unique(provider, provider_event_id) |
| Raw body for HMAC | PASS — bodyParser disabled |
| Timing-safe comparison | PASS — crypto.timingSafeEqual |

---

## 6. OAuth Security

| Check | Status |
|---|---|
| State parameter HMAC | PASS — signState/verifyState |
| State expiry | PASS — 10-minute max age |
| Timing-safe comparison | PASS — crypto.timingSafeEqual |
| Pending connection encryption | PASS — AES-256-GCM |
| Single-use consumption | PASS — atomic consumed_at filter |
| Cross-user finalization check | PASS — pending.user_id verified |

---

## 7. Supabase Storage

**Not used.** No storage buckets, no file uploads. Section N/A.

---

## 8. Logging and Privacy

| Check | Status |
|---|---|
| Structured allowlisted logging (providers) | PASS — LOG_SAFE set |
| Webhook unmatched user log | REVIEW — logs checkout_email (necessary for support reconciliation) |
| No secrets in logs | PASS |
| Error messages to client | PASS — generic errors, no stack traces |

---

## 9. Priority Remediation Order

1. **CRITICAL** — Enable RLS + policies on profiles, activities, training_plans, training_sessions, strava_accounts
2. **HIGH** — Add rate limiting to generate-plan, weekly-analysis, memory/extract
3. **HIGH** — Add daily aggregate AI cap across all endpoints
4. **MEDIUM** — Make rate-limit increment atomic (upsert with increment)
5. **LOW** — Verify production RLS state matches migrations
