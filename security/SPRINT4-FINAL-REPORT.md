# Sprint 4 — Security Hardening Final Report

**Date:** 2026-07-26  
**Status:** Ready for review. NOT committed.

---

## What changed

### New files (untracked)

| File | Purpose |
|---|---|
| `security/phase1-security-matrix.md` | Full security inventory of every table, API route, secret, and rate limit |
| `security/001-atomic-rate-limit-rpc.sql` | Migration 001: Atomic rate-limit RPC function (low-risk, apply first) |
| `security/001-atomic-rate-limit-rpc-rollback.sql` | Rollback for migration 001 |
| `security/002-athlete-table-rls.sql` | Migration 002: RLS + policies for 5 unprotected tables (conditional on schema verification) |
| `security/002-athlete-table-rls-rollback.sql` | Rollback for migration 002 (drops policies, does NOT disable RLS) |
| `security/production-rls-check.sql` | Read-only production inspection SQL (16 verification queries) |
| `tests/security-isolation.test.mjs` | Security test suite with migration separation assertions |
| `security/SPRINT4-FINAL-REPORT.md` | This file |

### Removed files

| File | Reason |
|---|---|
| `security/remediation-migration.sql` | Replaced by split migrations 001 + 002 |
| `security/rollback-migration.sql` | Replaced by per-migration rollback files |

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

1. **5 tables had no RLS migration:** `profiles`, `activities`, `training_plans`, `training_sessions`, `strava_accounts`. Any authenticated user could query any other user's data via the Supabase anon key. **Fix:** `security/002-athlete-table-rls.sql` enables RLS + auth.uid()-scoped policies on all 5 tables.

2. **3 AI endpoints had no rate limiting:** `generate-plan` (most expensive, 60s timeout), `weekly-analysis`, `memory/extract`. A single user could generate unlimited OpenAI costs. **Fix:** All 3 now import and call `checkAiRateLimit()`.

### HIGH — Fixed

3. **Non-atomic rate limit increment:** The read-then-write pattern allowed concurrent requests to bypass limits. **Fix:** `security/001-atomic-rate-limit-rpc.sql` creates a SECURITY DEFINER `increment_rate_limit` function that does INSERT...ON CONFLICT...DO UPDATE atomically. The JS code calls this RPC first, falling back to the legacy path until deployed.

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

**IMPORTANT:** Committing SQL to Git does NOT mean it has been applied to Supabase. Each migration must be run manually in the Supabase SQL Editor after verification.

### Step 1 — Deploy runtime rate limiting (already committed)
- [ ] Deploy the 4 modified API files to Vercel. The rate limit changes are backward-compatible — the RPC function call fails gracefully to the legacy path until migration 001 is applied.

### Step 2 — Run production read-only inspection
- [ ] Run `security/production-rls-check.sql` in Supabase SQL Editor. This performs NO mutations. Review the output to confirm table schemas, ownership columns, and current RLS state.

### Step 3 — Apply migration 001 (low-risk)
- [ ] Run `security/001-atomic-rate-limit-rpc.sql` in Supabase SQL Editor. This only creates one function and hardens its permissions. It does not touch any user-data tables.
- [ ] Test AI endpoints — verify rate limiting works and returns 429 when limits are exceeded.
- [ ] If anything breaks, run `security/001-atomic-rate-limit-rpc-rollback.sql` to drop the function. The JS code falls back to the legacy path automatically.

### Step 4 — Apply migration 002 (conditional on schema verification)
- [ ] Re-run `security/production-rls-check.sql` to confirm all 5 target tables exist and ownership columns are UUID-type.
- [ ] Run `security/002-athlete-table-rls.sql` in Supabase SQL Editor. This enables RLS and creates auth.uid()-scoped policies.
- [ ] Test cross-account isolation: sign in as a real user and verify profile loads, activities load, training plan view works, strava connection status shows (will return empty — frontend handles gracefully).
- [ ] Test normal user flows end-to-end.
- [ ] If anything breaks, run `security/002-athlete-table-rls-rollback.sql` to drop policies. Note: this does NOT disable RLS (previous state unknown). To fully disable RLS, do so manually after confirming the previous state.

### Risk assessment
- **Migration 001** is expected to be low-risk: it creates a single function that the JS code already handles gracefully if missing.
- **Migration 002** remains conditional on production schema verification. If ownership columns are not UUID or tables have unexpected structures, policies could block all access.

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
