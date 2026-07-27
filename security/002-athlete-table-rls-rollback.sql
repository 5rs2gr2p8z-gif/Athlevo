/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Rollback 002: Drop Athlete-Owned Table RLS Policies
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Reverses migration 002. Drops ONLY the policies introduced by
 *  002-athlete-table-rls.sql.
 *
 *  IMPORTANT:
 *    - Does NOT disable RLS on any table. The previous production
 *      state is unknown — RLS may have been enabled before this
 *      migration. Disabling it blindly could open a wider gap than
 *      the one we're rolling back.
 *    - Does NOT touch the rate-limit RPC function (migration 001).
 *    - Does NOT touch policies from other migrations.
 *    - All DROP POLICY statements are idempotent (IF EXISTS).
 *
 *  If you need to fully disable RLS on these tables, do so manually
 *  after confirming the previous state in the Supabase dashboard.
 */


-- ═══════════════════════════════════════════════════════════════
-- 1. profiles
-- ═══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Athletes read own profile"   ON public.profiles;
DROP POLICY IF EXISTS "Athletes update own profile"  ON public.profiles;
DROP POLICY IF EXISTS "Athletes insert own profile"  ON public.profiles;


-- ═══════════════════════════════════════════════════════════════
-- 2. activities
-- ═══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Athletes read own activities"   ON public.activities;
DROP POLICY IF EXISTS "Athletes insert own activities"  ON public.activities;
DROP POLICY IF EXISTS "Athletes update own activities"  ON public.activities;
DROP POLICY IF EXISTS "Athletes delete own activities"  ON public.activities;


-- ═══════════════════════════════════════════════════════════════
-- 3. training_plans
-- ═══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Athletes read own plans"   ON public.training_plans;
DROP POLICY IF EXISTS "Athletes insert own plans"  ON public.training_plans;
DROP POLICY IF EXISTS "Athletes update own plans"  ON public.training_plans;


-- ═══════════════════════════════════════════════════════════════
-- 4. training_sessions
-- ═══════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Athletes read own sessions"   ON public.training_sessions;
DROP POLICY IF EXISTS "Athletes insert own sessions"  ON public.training_sessions;
DROP POLICY IF EXISTS "Athletes update own sessions"  ON public.training_sessions;
DROP POLICY IF EXISTS "Athletes delete own sessions"  ON public.training_sessions;


-- ═══════════════════════════════════════════════════════════════
-- 5. strava_accounts
--    No policies were created (server-only table), so nothing
--    to drop. Listed for completeness.
-- ═══════════════════════════════════════════════════════════════

-- (no policies to drop — strava_accounts had no client policies)
