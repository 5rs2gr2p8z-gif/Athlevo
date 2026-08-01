-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — Coach Dashboard bootstrap (MANUAL, REVIEWED, EXAMPLE ONLY)
-- ══════════════════════════════════════════════════════════════════════
--
--  Run in the Supabase SQL editor with the service role, AFTER reviewing.
--  Nothing here runs automatically. This file contains ONLY placeholder
--  UUIDs — never commit real production user UUIDs. Replace the placeholders
--  with real values at run time (do not save them back into this file).
--
--  Prerequisite: apply migrations/2026-08-01_coach_dashboard.sql first.
--
--  This demonstrates the exact, reversible steps to:
--    1. promote your own account to coach (or admin)
--    2. assign one existing athlete to that coach
--    3. verify the relationship
--    4. revoke the assignment safely
--
--  It does NOT modify any athlete's data, plan, or identity.

-- ─── 0. Find the UUIDs you need (read-only; copy them out) ─────────────
-- SELECT id, email FROM auth.users WHERE email = 'you@example.com';       -- coach
-- SELECT id, email FROM auth.users WHERE email = 'client@example.com';    -- athlete

-- ─── 1. Promote your account to coach ─────────────────────────────────
-- Use 'admin' instead of 'coach' if you also need to manage assignments.
UPDATE public.profiles
   SET role = 'coach'
 WHERE id = '00000000-0000-0000-0000-000000000000';  -- ← your coach UUID

-- ─── 2. Assign ONE existing athlete to the coach (status = active) ─────
-- created_by is the actor performing the assignment (you/admin). The partial
-- unique index prevents a duplicate live assignment for the same pair.
INSERT INTO public.coach_athlete_assignments
  (coach_id, athlete_id, status, permission_level, created_by, assigned_at)
VALUES
  ('00000000-0000-0000-0000-000000000000',   -- ← coach UUID
   '11111111-1111-1111-1111-111111111111',   -- ← athlete UUID
   'active', 'read',
   '00000000-0000-0000-0000-000000000000',   -- ← created_by (admin/coach)
   now())
ON CONFLICT DO NOTHING;

-- ─── 3. Verify the relationship ───────────────────────────────────────
-- Confirms the role and the active link. Should return exactly one row.
-- SELECT p.role, a.status, a.assigned_at
--   FROM public.coach_athlete_assignments a
--   JOIN public.profiles p ON p.id = a.coach_id
--  WHERE a.coach_id  = '00000000-0000-0000-0000-000000000000'
--    AND a.athlete_id = '11111111-1111-1111-1111-111111111111'
--    AND a.status = 'active';

-- Confirm RLS grants the coach read access to that athlete only:
-- SELECT public.athlevo_is_active_coach_of('11111111-1111-1111-1111-111111111111');  -- run as the coach

-- ─── 4. Revoke the assignment safely (auditable; keeps history) ────────
-- Ending an assignment immediately removes access (RLS checks status='active')
-- while preserving the row for audit. It does NOT delete anything.
-- UPDATE public.coach_athlete_assignments
--    SET status = 'ended', ended_at = now(), updated_at = now()
--  WHERE coach_id  = '00000000-0000-0000-0000-000000000000'
--    AND athlete_id = '11111111-1111-1111-1111-111111111111'
--    AND status = 'active';

-- Optional: demote the account back to athlete.
-- UPDATE public.profiles SET role = 'athlete'
--  WHERE id = '00000000-0000-0000-0000-000000000000';
