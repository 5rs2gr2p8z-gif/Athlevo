# Sprint 4 — Security Hardening Final Report

**Date:** 2026-07-26  
**Status:** Ready for review. NOT committed.

---

## What changed

### New files (untracked)

| File | Purpose |
|---|---|
| `security/phase1-security-matrix.md` | Full security inventory of every table, API route, secret, and rate limit |
| `security/remediation-migration.sql` | Idempotent SQL: RLS + policies for 5 unprotected tables, atomic rate-limit function |
| `security/rollback-migration.sql` | Reversal SQL for all remediation changes |
| `tests/security-isolation.test.mjs` | 77-assertion security test suite |
| `security/SPRINT4-FINAL-REPORT.md` | This file |

### Modified files (tracked)

| File | Change |
|---|---|
| `lib/server/rateLimit.js` | Added `generate-plan` (5/hr) and `weekly-analysis` (10/hr) to AI_LIMITS. Added atomic RPC increment path. Added daily aggregate cap (200/day across all endpoints). |
| `api/memory/extract.js` | Added import + call to `checkAiRateLimit(user.id, "memory-extract")` |
| `api/training/generate-plan.js` | Added import + call to `checkAiRateLimit(user.id, "generate-plan")` |
| `api/training/weekly-analysis.js` | Added import + call to `checkAiRateLimit(user.id, "weekly-analysis")` |

---

## Vulnerabilities found and fixed

### CRITICAL — Fixed

1. **5 tables had no RLS migration:** `profiles`, `activities`, `training_plans`, `training_sessions`, `strava_accounts`. Any authenticated user could query any other user's data via the Supabase anon key. **Fix:** `remediation-migration.sql` enables RLS + auth.uid()-scoped policies on all 5 tables.

2. **3 AI endpoints had no rate limiting:** `generate-plan` (most expensive, 60s timeout), `weekly-analysis`, `memory/extract`. A single user could generate unlimited OpenAI costs. **Fix:** All 3 now import and call `checkAiRateLimit()`.

### HIGH — Fixed

3. **Non-atomic rate limit increment:** The read-then-write pattern allowed concurrent requests to bypass limits. **Fix:** `increment_rate_limit` Postgres function does INSERT...ON CONFLICT...DO UPDATE atomically. The JS code calls this RPC first, falling back to the legacy path until deployed.

4. **No daily aggregate cap:** Hourly limits allowed 40/hr × 24hr = 960 coach calls/day. **Fix:** 200/day aggregate cap across all AI endpoints.

### Already secure (confirmed)

- All API routes authenticate via Bearer→Supabase JWT. User identity from JWT, never request body.
- No secrets in frontend code (only publishable Supabase URL/anon key and PostHog public token).
- Webhook HMAC verification with replay protection and idempotent processing.
- OAuth state HMAC with timing-safe comparison and 10-minute expiry.
- Subscription writes are server-only (no INSERT/UPDATE RLS policies for users).
- Provider tokens (provider_accounts, pending_provider_connections) are service-role only.
- No Supabase Storage in use (Section 8 N/A).

---

## Rate limit thresholds

| Endpoint | Hourly limit | Rationale |
|---|---|---|
| coach | 40/hr | Chatty session = ~30 messages |
| daily-brief | 30/hr | Generated on open, fingerprint-cached |
| memory-extract | 60/hr | Runs per athlete message |
| generate-plan | 5/hr | Most expensive call (~60s GPT-5.5) |
| weekly-analysis | 10/hr | Moderately expensive analysis |
| **Daily aggregate** | **200/day** | All endpoints combined |

---

## Test results

```
Security isolation: 77 passed, 0 failed
Access guard:       46 passed, 0 failed
Whop:               47 passed, 0 failed
Paywall:            54 passed, 0 failed
Analytics:          56 passed, 0 failed
Founding beta:      79 passed, 0 failed
Motion system:      13 passed, 0 failed
Design tokens:      43 passed, 0 failed
```

---

## Production deployment checklist

Before committing, verify these against your production Supabase:

- [ ] **Check current RLS state** on the 5 critical tables. Run in Supabase SQL Editor:
  ```sql
  SELECT tablename, rowsecurity FROM pg_tables
  WHERE schemaname = 'public'
  AND tablename IN ('profiles','activities','training_plans',
                     'training_sessions','strava_accounts');
  ```
  If `rowsecurity = true` on any table, it already has RLS — the migration's `enable row level security` is a safe no-op, but check existing policies don't conflict.

- [ ] **Run `remediation-migration.sql`** in Supabase SQL Editor (or via CLI migration). This is idempotent and can be run multiple times safely.

- [ ] **Test client queries still work** after RLS is enabled. Sign in as a real user and verify: profile loads, activities load, training plan view works, strava connection status shows.

- [ ] **Deploy the 4 modified API files** to Vercel. The rate limit changes are backward-compatible — the RPC function call fails gracefully to the legacy path until the migration is run.

- [ ] **Verify rate limiting** by checking Vercel function logs for the new endpoints after deployment.

- [ ] If anything breaks, run `rollback-migration.sql` to disable RLS on the 5 tables and drop the RPC function.

---

## What this sprint did NOT change

Per the sprint constraints:

- No UI changes
- No product features added
- No database schema changes (only RLS policies and a function)
- No broad refactoring
- No automatic commits
- No .env files created or modified
- No paid services added
- OAuth state/completion-token/ownership protections untouched
