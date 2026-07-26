/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Production RLS Verification Query  (READ-ONLY)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Run this in Supabase SQL Editor BEFORE applying remediation-migration.sql.
 *  It does not modify anything. It reports the current RLS state of every
 *  table in the public schema.
 *
 *  What to look for:
 *    - rowsecurity = false on any user-data table → CRITICAL gap
 *    - Missing policies on tables with rowsecurity = true → data blocked
 *    - Existing policies that might conflict with remediation names
 *    - relforcerowlevel = true → FORCE RLS already applied
 */

-- 1. Table-level RLS status for all public tables
SELECT
  c.relname                             AS table_name,
  c.relrowsecurity                      AS rls_enabled,
  c.relforcerowlevel                    AS force_rls,
  CASE
    WHEN c.relname IN (
      'profiles', 'activities', 'training_plans',
      'training_sessions', 'strava_accounts'
    ) THEN 'CRITICAL — remediation target'
    ELSE 'existing'
  END                                   AS category
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'  -- ordinary tables only
ORDER BY
  CASE WHEN c.relname IN (
    'profiles', 'activities', 'training_plans',
    'training_sessions', 'strava_accounts'
  ) THEN 0 ELSE 1 END,
  c.relname;


-- 2. All existing RLS policies in the public schema
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual       AS using_expression,
  with_check AS with_check_expression
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd, policyname;


-- 3. Check for policy name conflicts with remediation migration
SELECT
  tablename,
  policyname,
  cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname IN (
    'Athletes read own profile',
    'Athletes update own profile',
    'Athletes insert own profile',
    'Athletes read own activities',
    'Athletes insert own activities',
    'Athletes update own activities',
    'Athletes delete own activities',
    'Athletes read own plans',
    'Athletes insert own plans',
    'Athletes update own plans',
    'Athletes read own sessions',
    'Athletes insert own sessions',
    'Athletes update own sessions',
    'Athletes delete own sessions',
    'Athletes read own strava account'
  )
ORDER BY tablename, policyname;


-- 4. Check for the rate-limit RPC function
SELECT
  p.proname                             AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  p.prosecdef                           AS security_definer,
  r.rolname                             AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE n.nspname = 'public'
  AND p.proname = 'increment_rate_limit';


-- 5. Verify column existence and types for ownership checks
SELECT
  table_name,
  column_name,
  data_type,
  udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'profiles', 'activities', 'training_plans',
    'training_sessions', 'strava_accounts'
  )
  AND column_name IN ('id', 'user_id')
ORDER BY table_name, column_name;


-- 6. Verify ai_rate_limits table structure for RPC function
SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'ai_rate_limits'
ORDER BY ordinal_position;


-- 7. Check grants on increment_rate_limit (if it exists)
SELECT
  grantee,
  privilege_type
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name = 'increment_rate_limit';
