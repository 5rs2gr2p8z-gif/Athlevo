/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Production RLS Verification Query  (READ-ONLY)
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Run this in Supabase SQL Editor BEFORE applying any migration.
 *  It performs NO mutations — every statement is a SELECT.
 *
 *  Covers:
 *    1.  Whether each target table exists
 *    2.  Target table columns and data types
 *    3.  Whether expected ownership columns exist
 *    4.  Whether ownership columns are UUID-compatible with auth.uid()
 *    5.  relrowsecurity (RLS enabled)
 *    6.  relforcerowsecurity (FORCE RLS)
 *    7.  All existing policies (schema, table, name, permissive/
 *        restrictive, roles, command, USING, WITH CHECK)
 *    8.  Existing grants to anon and authenticated
 *    9.  Functions named increment_rate_limit
 *   10.  Exact function signatures
 *   11.  Function owner
 *   12.  Function security-definer status
 *   13.  Function ACL/execution grants
 *   14.  public.ai_rate_limits constraints and primary key
 *   15.  Views based on the five target tables
 *   16.  Whether any such views use security_invoker
 */


-- ═══════════════════════════════════════════════════════════════
-- 1. Table existence check for all target tables
-- ═══════════════════════════════════════════════════════════════

SELECT
  t.expected_table,
  EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND c.relname = t.expected_table
  ) AS table_exists
FROM unnest(ARRAY[
  'profiles', 'activities', 'training_plans',
  'training_sessions', 'strava_accounts', 'ai_rate_limits'
]) AS t(expected_table);

-- Workaround: individual checks if the above unnest form is unsupported
SELECT 'profiles' AS table_name,
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='profiles') AS exists
UNION ALL SELECT 'activities',
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='activities')
UNION ALL SELECT 'training_plans',
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='training_plans')
UNION ALL SELECT 'training_sessions',
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='training_sessions')
UNION ALL SELECT 'strava_accounts',
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='strava_accounts')
UNION ALL SELECT 'ai_rate_limits',
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_rate_limits');


-- ═══════════════════════════════════════════════════════════════
-- 2–4. Columns, data types, ownership columns, UUID compatibility
-- ═══════════════════════════════════════════════════════════════

SELECT
  table_name,
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default,
  CASE
    WHEN column_name IN ('id', 'user_id') THEN 'OWNERSHIP COLUMN'
    ELSE ''
  END AS ownership_role,
  CASE
    WHEN column_name IN ('id', 'user_id') AND udt_name = 'uuid' THEN 'YES — UUID-compatible with auth.uid()'
    WHEN column_name IN ('id', 'user_id') AND udt_name != 'uuid' THEN 'WARNING — NOT UUID, auth.uid() comparison may fail'
    ELSE ''
  END AS uuid_compatible
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN (
    'profiles', 'activities', 'training_plans',
    'training_sessions', 'strava_accounts'
  )
ORDER BY table_name, ordinal_position;


-- ═══════════════════════════════════════════════════════════════
-- 5–6. RLS status: relrowsecurity and relforcerowsecurity
-- ═══════════════════════════════════════════════════════════════

SELECT
  c.relname                             AS table_name,
  c.relrowsecurity                      AS rls_enabled,
  c.relforcerowsecurity                  AS force_rls,
  CASE
    WHEN c.relname IN (
      'profiles', 'activities', 'training_plans',
      'training_sessions', 'strava_accounts'
    ) THEN 'MIGRATION 002 TARGET'
    WHEN c.relname = 'ai_rate_limits' THEN 'MIGRATION 001 DEPENDENCY'
    ELSE 'other'
  END                                   AS category
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY
  CASE WHEN c.relname IN (
    'profiles', 'activities', 'training_plans',
    'training_sessions', 'strava_accounts', 'ai_rate_limits'
  ) THEN 0 ELSE 1 END,
  c.relname;


-- ═══════════════════════════════════════════════════════════════
-- 7. All existing RLS policies in the public schema
-- ═══════════════════════════════════════════════════════════════

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


-- ═══════════════════════════════════════════════════════════════
-- 8. Existing grants to anon and authenticated on target tables
-- ═══════════════════════════════════════════════════════════════

SELECT
  grantee,
  table_schema,
  table_name,
  privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND table_name IN (
    'profiles', 'activities', 'training_plans',
    'training_sessions', 'strava_accounts', 'ai_rate_limits'
  )
  AND grantee IN ('anon', 'authenticated')
ORDER BY table_name, grantee, privilege_type;


-- ═══════════════════════════════════════════════════════════════
-- 9–12. Functions named increment_rate_limit: signature, owner,
--        security-definer status
-- ═══════════════════════════════════════════════════════════════

SELECT
  n.nspname                                    AS schema,
  p.proname                                    AS function_name,
  pg_get_function_identity_arguments(p.oid)    AS arguments,
  pg_get_function_result(p.oid)                AS return_type,
  p.prosecdef                                  AS security_definer,
  r.rolname                                    AS owner,
  p.proconfig                                  AS config_settings,
  pg_get_functiondef(p.oid)                    AS full_definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
WHERE p.proname = 'increment_rate_limit';


-- ═══════════════════════════════════════════════════════════════
-- 13. Function ACL / execution grants
-- ═══════════════════════════════════════════════════════════════

SELECT
  p.proname                                    AS function_name,
  pg_get_function_identity_arguments(p.oid)    AS arguments,
  p.proacl                                     AS acl_raw,
  -- Also check information_schema for structured view
  rp.grantee,
  rp.privilege_type
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN information_schema.routine_privileges rp
  ON rp.routine_schema = n.nspname
  AND rp.routine_name = p.proname
WHERE n.nspname = 'public'
  AND p.proname = 'increment_rate_limit'
ORDER BY rp.grantee;


-- ═══════════════════════════════════════════════════════════════
-- 14. public.ai_rate_limits constraints and primary key
-- ═══════════════════════════════════════════════════════════════

-- Table columns
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

-- Constraints (PK, unique, check)
SELECT
  tc.constraint_name,
  tc.constraint_type,
  kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.table_schema = 'public'
  AND tc.table_name = 'ai_rate_limits'
ORDER BY tc.constraint_type, kcu.ordinal_position;

-- Indexes (including unique indexes that enforce ON CONFLICT)
SELECT
  i.relname AS index_name,
  ix.indisunique AS is_unique,
  ix.indisprimary AS is_primary,
  array_agg(a.attname ORDER BY x.n) AS columns
FROM pg_index ix
JOIN pg_class t ON t.oid = ix.indrelid
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, n)
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
WHERE n.nspname = 'public' AND t.relname = 'ai_rate_limits'
GROUP BY i.relname, ix.indisunique, ix.indisprimary
ORDER BY ix.indisprimary DESC, i.relname;


-- ═══════════════════════════════════════════════════════════════
-- 15. Views based on the five target tables
-- ═══════════════════════════════════════════════════════════════

SELECT DISTINCT
  v.table_name AS view_name,
  vcu.table_name AS source_table
FROM information_schema.views v
JOIN information_schema.view_column_usage vcu
  ON v.table_schema = vcu.view_schema
  AND v.table_name = vcu.view_name
WHERE v.table_schema = 'public'
  AND vcu.table_schema = 'public'
  AND vcu.table_name IN (
    'profiles', 'activities', 'training_plans',
    'training_sessions', 'strava_accounts'
  )
ORDER BY view_name, source_table;


-- ═══════════════════════════════════════════════════════════════
-- 16. Whether any views on target tables use security_invoker
-- ═══════════════════════════════════════════════════════════════

SELECT
  c.relname AS view_name,
  -- security_invoker was added in PG 15; reloptions stores it
  c.reloptions,
  CASE
    WHEN c.reloptions::text LIKE '%security_invoker=true%' THEN 'YES — security_invoker enabled'
    WHEN c.reloptions::text LIKE '%security_invoker=on%' THEN 'YES — security_invoker enabled'
    ELSE 'NO — view runs as definer (default)'
  END AS security_invoker_status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'v'
  AND c.oid IN (
    SELECT DISTINCT d.refobjid
    FROM pg_depend d
    JOIN pg_class src ON src.oid = d.refobjid
    JOIN pg_namespace sn ON sn.oid = src.relnamespace
    WHERE sn.nspname = 'public'
      AND src.relname IN (
        'profiles', 'activities', 'training_plans',
        'training_sessions', 'strava_accounts'
      )
  )
ORDER BY c.relname;
