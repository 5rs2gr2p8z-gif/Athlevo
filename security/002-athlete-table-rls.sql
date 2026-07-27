/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Migration 002: Athlete-Owned Table RLS Policies
 * ══════════════════════════════════════════════════════════════════════
 *
 *  PURPOSE:  Enable RLS and add user-scoped policies on the 5 tables
 *            that pre-date the migrations directory.
 *
 *  TABLES:
 *    1. public.profiles        (ownership: id = auth.uid())
 *    2. public.activities      (ownership: user_id = auth.uid())
 *    3. public.training_plans  (ownership: user_id = auth.uid())
 *    4. public.training_sessions (ownership: user_id = auth.uid())
 *    5. public.strava_accounts (ownership: user_id = auth.uid())
 *
 *  SCOPE:  This file contains ONLY RLS changes for athlete-owned
 *          tables. It does NOT contain the rate-limit RPC function
 *          (see 001-atomic-rate-limit-rpc.sql).
 *
 *  SAFETY:
 *    - Every statement is idempotent (IF NOT EXISTS / DO $$ checks).
 *    - ENABLE ROW LEVEL SECURITY is a no-op if already enabled.
 *    - FORCE ROW LEVEL SECURITY is intentionally NOT used.
 *    - Policies use auth.uid() for ownership — never a parameter.
 *    - No data is modified. No columns are added or dropped.
 *    - Service-role access is unaffected (bypasses RLS).
 *    - strava_accounts has NO client SELECT policy (tokens are
 *      server-only). RLS with no SELECT policy = zero rows for
 *      anon/authenticated.
 *
 *  BEFORE RUNNING:
 *    1. Run security/production-rls-check.sql to verify current state.
 *    2. Confirm table columns and types match expectations.
 *    3. Migration 001 should be applied first (independent, but
 *       establishes the deployment pattern).
 *
 *  ROLLBACK:  See 002-athlete-table-rls-rollback.sql
 */


-- ═══════════════════════════════════════════════════════════════
-- 1. profiles  (ownership column: id = auth.uid())
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles'
      AND policyname = 'Athletes read own profile'
  ) THEN
    CREATE POLICY "Athletes read own profile"
      ON public.profiles FOR SELECT
      USING (auth.uid() IS NOT NULL AND auth.uid() = id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles'
      AND policyname = 'Athletes update own profile'
  ) THEN
    CREATE POLICY "Athletes update own profile"
      ON public.profiles FOR UPDATE
      USING (auth.uid() IS NOT NULL AND auth.uid() = id)
      WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles'
      AND policyname = 'Athletes insert own profile'
  ) THEN
    CREATE POLICY "Athletes insert own profile"
      ON public.profiles FOR INSERT
      WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = id);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- 2. activities  (ownership column: user_id = auth.uid())
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activities'
      AND policyname = 'Athletes read own activities'
  ) THEN
    CREATE POLICY "Athletes read own activities"
      ON public.activities FOR SELECT
      USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activities'
      AND policyname = 'Athletes insert own activities'
  ) THEN
    CREATE POLICY "Athletes insert own activities"
      ON public.activities FOR INSERT
      WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activities'
      AND policyname = 'Athletes update own activities'
  ) THEN
    CREATE POLICY "Athletes update own activities"
      ON public.activities FOR UPDATE
      USING (auth.uid() IS NOT NULL AND auth.uid() = user_id)
      WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'activities'
      AND policyname = 'Athletes delete own activities'
  ) THEN
    CREATE POLICY "Athletes delete own activities"
      ON public.activities FOR DELETE
      USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- 3. training_plans  (ownership column: user_id = auth.uid())
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.training_plans ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'training_plans'
      AND policyname = 'Athletes read own plans'
  ) THEN
    CREATE POLICY "Athletes read own plans"
      ON public.training_plans FOR SELECT
      USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'training_plans'
      AND policyname = 'Athletes insert own plans'
  ) THEN
    CREATE POLICY "Athletes insert own plans"
      ON public.training_plans FOR INSERT
      WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'training_plans'
      AND policyname = 'Athletes update own plans'
  ) THEN
    CREATE POLICY "Athletes update own plans"
      ON public.training_plans FOR UPDATE
      USING (auth.uid() IS NOT NULL AND auth.uid() = user_id)
      WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- 4. training_sessions  (ownership column: user_id = auth.uid())
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.training_sessions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'training_sessions'
      AND policyname = 'Athletes read own sessions'
  ) THEN
    CREATE POLICY "Athletes read own sessions"
      ON public.training_sessions FOR SELECT
      USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'training_sessions'
      AND policyname = 'Athletes insert own sessions'
  ) THEN
    CREATE POLICY "Athletes insert own sessions"
      ON public.training_sessions FOR INSERT
      WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'training_sessions'
      AND policyname = 'Athletes update own sessions'
  ) THEN
    CREATE POLICY "Athletes update own sessions"
      ON public.training_sessions FOR UPDATE
      USING (auth.uid() IS NOT NULL AND auth.uid() = user_id)
      WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'training_sessions'
      AND policyname = 'Athletes delete own sessions'
  ) THEN
    CREATE POLICY "Athletes delete own sessions"
      ON public.training_sessions FOR DELETE
      USING (auth.uid() IS NOT NULL AND auth.uid() = user_id);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════
-- 5. strava_accounts  (ownership column: user_id = auth.uid())
--    CRITICAL: contains OAuth access_token and refresh_token.
--    NO client SELECT policy — tokens must only be read server-side.
--    NO INSERT/UPDATE/DELETE for client — all writes are server-side
--    via service role during OAuth callback and sync.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE public.strava_accounts ENABLE ROW LEVEL SECURITY;

-- RLS enabled with NO policies = zero rows returned for
-- anon/authenticated roles. Service role bypasses RLS and
-- can still read/write. This is the correct state for a table
-- containing OAuth tokens.
--
-- If the Strava connection status indicator breaks (frontend
-- queries strava_accounts for existence check), consider adding
-- a narrow view or a single-column RLS policy — but accept the
-- tradeoff that the client would then see its own tokens.


-- ═══════════════════════════════════════════════════════════════
-- NOTE: FORCE ROW LEVEL SECURITY is intentionally NOT applied.
-- FORCE RLS makes policies apply even to the table owner role.
-- This could break Supabase dashboard access, pg_dump, or
-- migrations that run as the table owner. Standard ENABLE RLS
-- is sufficient: it applies to anon and authenticated roles
-- (which is the threat model). Service role bypasses regardless.
-- ═══════════════════════════════════════════════════════════════
