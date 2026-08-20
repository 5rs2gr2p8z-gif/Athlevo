# Athlevo Coach Diagnostic Report

**Date:** 2026-08-01
**Severity:** Production-critical
**Scope:** Web/PWA Coach feature

---

## A. Native iOS Stale-Build Issue (Not the Production Root Cause)

The `dist/js/coach.js` file was stale — it hadn't been rebuilt after the error taxonomy was updated. The dist copy was still checking for `FREE_LIMIT_REACHED` while the server returns `COACH_WEEKLY_LIMIT_REACHED`. This would cause the upgrade sheet to not appear when the free weekly limit is hit, showing a generic error instead.

**Impact:** iOS native users only. The iOS app has NOT been released, so no production users were affected by this issue.

**Fix:** Run `npm run build:native` on the host machine. This copies all 49 JS files from `js/` to `dist/js/` with the Supabase CDN swap. Do NOT manually edit dist files — they are gitignored generated output.

**Status:** Not yet rebuilt (sandbox lacks write permission to mounted `dist/`). Must be run on host before any iOS build.

---

## B. Actual Deployed Web Coach Issue

### What web users load

Web/PWA users load `js/coach.js` (source) directly via `index.html` — NOT `dist/js/coach.js`. The source file is correct: it has `classifyCoachFailure()`, `resolveCoachAccessState()`, `restoreCoachDraft()`, `showCoachLimitUpgrade()`, `claimCoachRequest()`, `trackCoachEvent()`, the full error taxonomy, and saves user messages only after success.

### Code analysis: no code-level bug found

I traced the entire web Coach request path:

1. **`askCoach(question)`** → `claimCoachRequest()` duplicate guard → `resolveCoachAccessState()` → clear composer → add chat bubbles → build context → `fetch("/api/coach")` → parse response → render or error
2. **`resolveCoachAccessState()`** → `cachedAccessState()` (checks `AthlevoPlan.isLoaded()`) → fallback to `accessState()` (calls `AthlevoPlan.load()`) → returns "free", "paid_active", "paid_inactive", or "unknown"
3. **`api/coach.js`** → auth → input validation → rate limit → free usage check → OpenAI Responses API (`gpt-5.5`, structured JSON) → parse → validate actions → respond
4. **Error handling:** All context-building functions (`loadAthleteProfile`, `loadAthleteActivities`, `loadAthleteMemory`, `loadRecentConversationForCoach`, `loadWeekExecutionForCoach`, `loadTodayReadinessForCoach`, `extractAthleteMemoryFromMessage`) have try/catch and return null/[] on failure — they never crash `askCoach()`
5. **Service worker:** Navigations are network-first (always fresh `index.html`). Static assets use stale-while-revalidate with `?v=` cache-busting. API calls are never cached (POST method + `/api/` in NEVER_CACHE list).
6. **CORS:** Same-origin, not an issue.
7. **Script load order:** `brain.js` → `memory.js` → `renderCoachResponse.js` → `coach.js` → `features.js` → `accessGuard.js`. All dependencies are on `window.*` globals resolved at call time (not parse time), so ordering is safe.
8. **JS syntax:** All Coach-related files parse cleanly.

### Most likely production failure cause: access state resolution

The one path that causes a **silent failure** (no inline error, only a transient toast) is when `resolveCoachAccessState()` returns `"unknown"`:

```
askCoach() → resolveCoachAccessState() → "unknown" →
  toast("We couldn't verify your access. Try again.") →
  return (no API call made, no error in chat area)
```

This happens when `AthlevoPlan.load()` (i.e., `loadSubscription()`) fails. The function queries Supabase for the user's subscription row:

```javascript
const { data, error } = await supabaseClient
  .from("subscriptions")
  .select("*")
  .eq("user_id", user.id)
  .maybeSingle();
```

If this query errors (RLS misconfiguration, Supabase transient failure, network timeout, session JWT issue), `subscriptionLoaded` stays `false`, `cachedAccessState()` returns `"unknown"`, and Coach silently fails.

**Why this is the most likely cause:**
- It's the ONLY path that produces no visible feedback in the chat area (just a toast the user can easily miss)
- A user reporting "Coach doesn't work" or "nothing happens when I send a message" matches this behavior exactly
- All other failure paths produce visible inline errors with retry buttons

**What I cannot verify from code alone:**
- Whether the `subscriptions` table has correct RLS policies for authenticated reads
- Whether the Supabase client's JWT is reliably valid when Coach is used
- Whether `OPENAI_API_KEY` is set in the Vercel deployment
- Whether the OpenAI model `gpt-5.5` is currently available and accepts the Responses API format
- Whether the deployed Vercel functions match the current source

### Investigation checklist for production

To pin down the exact cause, check these in order:

1. **Vercel deployment:** Is the latest commit deployed? Compare deployed function hash to source.
2. **Environment variables:** Is `OPENAI_API_KEY` set in Vercel? Is `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set?
3. **Supabase `subscriptions` table RLS:** Does the authenticated user have `SELECT` permission on their own row? Run: `SELECT * FROM subscriptions WHERE user_id = '<user-id>'` with the user's JWT.
4. **Vercel function logs:** Check for `ai_auth_failed`, `coach_request_failed`, `ai_rate_limited` log entries.
5. **Browser console:** On the affected user's device, check for "Subscription load failed" or "Subscription load error" console warnings (from `loadSubscription()` in features.js).
6. **OpenAI API status:** Verify `gpt-5.5` model accepts requests at `https://api.openai.com/v1/responses`.

### Service worker cache: not a concern

The service worker uses stale-while-revalidate with version-stamped URLs (`js/coach.js?v=70`). When a deploy bumps the version, the first pageload serves the stale version (if cached) and fetches the new one. The second pageload gets the updated file. This self-corrects and cannot cause a persistent failure.

---

## Test Results

### Coach-specific tests: all pass

| Test file | Result |
|---|---|
| `tests/coach-limit.test.mjs` | 42 passed, 0 failed |
| `tests/freemium.test.mjs` | 58 passed, 0 failed |
| `tests/access-guard.test.mjs` | 23 passed, 0 failed |
| `tests/analytics.test.mjs` | 85 passed, 0 failed |
| `tests/service-worker-cache.test.mjs` | 18 passed, 0 failed |
| `tests/coach-ui.test.mjs` | 29 passed, 0 failed |
| `tests/security-isolation.test.mjs` | 113 passed, 0 failed |
| `tests/stale-session.test.mjs` | 27 passed, 0 failed |

### Full test suite: 56 of 62 test files pass

6 files have pre-existing failures in design system/UX polish tests (typography micro-clusters, card radii, shadow literals, CTA labels). None are Coach-related.

---

## What Was NOT Changed

Per the stated constraints:
- No cycling support added
- No Coach interface redesigned
- No commits, pushes, deploys, SQL applied, or production user data modified
- No dist/ files committed (they are gitignored)
- No service-worker cache version bumped (no deployed web asset changed)

## Before Deploying

1. Run `npm run build:native` on host to restore dist/ from source
2. Verify `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` are set in Vercel
3. Check Supabase RLS on `subscriptions` table allows authenticated SELECT
4. Check Vercel function logs for the reported failure timeframe
5. If the issue is the "unknown" access state path, consider adding an inline error (not just a toast) when entitlement resolution fails, so users get a visible retry button
