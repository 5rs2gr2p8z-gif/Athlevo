-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — Coach Dashboard MVP: roles, assignments, attention reviews, RLS
-- ══════════════════════════════════════════════════════════════════════
--
--  Run MANUALLY in the Supabase SQL editor AFTER review. Nothing here runs
--  automatically. This migration is ADDITIVE and preserves all existing data:
--  it adds a role column (default 'athlete'), two new tables, indexes, and
--  RLS. It does NOT reset users, does NOT change existing RLS on athlete
--  tables except to ADD narrowly-scoped coach-read policies, and does NOT
--  grant anyone coach/admin (that is a separate, reviewed manual step — see
--  the bootstrap script coach_bootstrap_example.sql).
--
--  Security model:
--    · Role lives on profiles.role (server-authoritative). Default athlete.
--    · A coach may read an athlete's data ONLY when an ACTIVE row exists in
--      coach_athlete_assignments. This is enforced twice: in the server
--      endpoint (api/coach-dashboard.js) AND here in RLS via
--      public.athlevo_is_active_coach_of(athlete), so a coach's own token can
--      never reach an unassigned athlete even by direct query.
--    · Coaches get SELECT only on athlete DATA tables. They get NO policy on
--      provider_accounts / strava_accounts / terra_accounts / subscriptions,
--      so OAuth tokens and payment records are never exposed.
--    · Athletes are unchanged: they still see only their own rows.

-- ─────────────────────────────────────────────────────────────────────
--  1. Role column on profiles (server-authoritative)
-- ─────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists role text not null default 'athlete';

alter table public.profiles
  drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('athlete', 'coach', 'admin'));

create index if not exists profiles_role_idx on public.profiles (role);

-- A user may NOT change their own role. Existing "update own profile" policies
-- typically allow updating any column; add a guard so role can only be changed
-- by the service role (which bypasses RLS) or an admin path. If your existing
-- update policy is broad, replace it with one that excludes role, e.g.:
--   create policy "Users update own profile except role"
--     on public.profiles for update
--     using (auth.uid() = id)
--     with check (auth.uid() = id AND role = (select p.role from public.profiles p where p.id = auth.uid()));
-- Review your current profiles UPDATE policy before applying the above.

-- ─────────────────────────────────────────────────────────────────────
--  2. Coach ⇄ Athlete assignments
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.coach_athlete_assignments (
  id            uuid primary key default gen_random_uuid(),
  coach_id      uuid not null references auth.users (id) on delete cascade,
  athlete_id    uuid not null references auth.users (id) on delete cascade,
  status        text not null default 'invited'
                  check (status in ('invited', 'active', 'paused', 'ended')),
  permission_level text not null default 'read'
                  check (permission_level in ('read', 'read_write')),
  created_by    uuid references auth.users (id) on delete set null,
  assigned_at   timestamptz not null default now(),
  ended_at      timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A coach cannot be assigned to themselves.
  constraint coach_athlete_distinct check (coach_id <> athlete_id)
);

-- At most ONE active (or invited/paused) assignment per coach–athlete pair.
-- Ended assignments are kept for audit, so uniqueness is partial on the set of
-- "live" statuses. Re-assigning after an 'ended' row is therefore allowed.
create unique index if not exists coach_athlete_live_unique
  on public.coach_athlete_assignments (coach_id, athlete_id)
  where status in ('invited', 'active', 'paused');

create index if not exists coach_athlete_coach_idx
  on public.coach_athlete_assignments (coach_id, status);
create index if not exists coach_athlete_athlete_idx
  on public.coach_athlete_assignments (athlete_id, status);

alter table public.coach_athlete_assignments enable row level security;

-- Coaches may READ their own assignment rows.
drop policy if exists "Coach reads own assignments" on public.coach_athlete_assignments;
create policy "Coach reads own assignments"
  on public.coach_athlete_assignments for select
  using (auth.uid() = coach_id);

-- Athletes may READ assignments where they are the athlete (to see who coaches
-- them) — but NOT create/modify them.
drop policy if exists "Athlete reads assignments about them" on public.coach_athlete_assignments;
create policy "Athlete reads assignments about them"
  on public.coach_athlete_assignments for select
  using (auth.uid() = athlete_id);

-- NO client insert/update/delete policy is defined on purpose: assignments are
-- created and mutated ONLY by the service role through reviewed admin/server
-- paths. This prevents an athlete self-assigning a coach and a coach claiming
-- an arbitrary athlete.

-- ─────────────────────────────────────────────────────────────────────
--  3. Attention-alert reviews (audit trail; not one row per render)
-- ─────────────────────────────────────────────────────────────────────
create table if not exists public.coach_attention_reviews (
  id           uuid primary key default gen_random_uuid(),
  coach_id     uuid not null references auth.users (id) on delete cascade,
  athlete_id   uuid not null references auth.users (id) on delete cascade,
  alert_key    text not null,           -- categorical reason key (e.g. 'pain_reported')
  reviewed_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- One CURRENT review per (coach, athlete, alert_key). "Mark reviewed" upserts
-- this row's reviewed_at rather than inserting on every render, so the table
-- does not grow per-view. History of WHAT was reviewed remains queryable; if a
-- full time-series audit is later required, drop this unique index and keep
-- append-only inserts.
create unique index if not exists coach_attention_reviews_unique
  on public.coach_attention_reviews (coach_id, athlete_id, alert_key);

create index if not exists coach_attention_reviews_coach_idx
  on public.coach_attention_reviews (coach_id, reviewed_at desc);

alter table public.coach_attention_reviews enable row level security;

drop policy if exists "Coach reads own reviews" on public.coach_attention_reviews;
create policy "Coach reads own reviews"
  on public.coach_attention_reviews for select
  using (auth.uid() = coach_id);
-- Inserts/updates happen through the service role in api/coach-dashboard.js
-- after the server re-verifies role + active assignment.

-- ─────────────────────────────────────────────────────────────────────
--  4. Assignment predicate (SECURITY DEFINER) used by coach-read RLS
-- ─────────────────────────────────────────────────────────────────────
-- Returns true iff the CURRENT auth user is an ACTIVE coach of `athlete`.
-- SECURITY DEFINER so the policy can consult coach_athlete_assignments without
-- recursing through that table's own RLS. Marked STABLE; no side effects.
create or replace function public.athlevo_is_active_coach_of(athlete uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.coach_athlete_assignments a
    where a.coach_id = auth.uid()
      and a.athlete_id = athlete
      and a.status = 'active'
  );
$$;

revoke all on function public.athlevo_is_active_coach_of(uuid) from public;
grant execute on function public.athlevo_is_active_coach_of(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────
--  5. Coach SELECT-only policies on athlete DATA tables (defense in depth)
-- ─────────────────────────────────────────────────────────────────────
-- These ADD to the existing "athlete sees own rows" policies; they never
-- replace or weaken them. Coaches get SELECT only, gated on an ACTIVE
-- assignment. Ended/paused/invited assignments grant nothing.
--
-- NOTE: profiles uses `id` as the athlete key; the data tables use `user_id`.

drop policy if exists "Coach reads assigned athlete profile" on public.profiles;
create policy "Coach reads assigned athlete profile"
  on public.profiles for select
  using (public.athlevo_is_active_coach_of(id));

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'activities',
    'daily_readiness',
    'athlete_metrics',
    'workout_execution_records',
    'weekly_progress_summaries',
    'training_sessions'
  ] loop

    -- Skip tables that do not exist in this project.
    if to_regclass(format('public.%I', tbl)) is null then
      raise notice 'Skipping missing table: public.%', tbl;
      continue;
    end if;

    -- Skip tables that do not have the expected user_id column.
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = tbl
        and column_name = 'user_id'
    ) then
      raise notice 'Skipping table without user_id: public.%', tbl;
      continue;
    end if;

    execute format(
      'drop policy if exists %I on public.%I',
      'Coach reads assigned athlete data',
      tbl
    );

    execute format(
      'create policy %I on public.%I for select using (public.athlevo_is_active_coach_of(user_id))',
      'Coach reads assigned athlete data',
      tbl
    );

  end loop;
end $$;

-- DELIBERATELY OMITTED — coaches get NO policy on these, so tokens & payment
-- data are never exposed to a coach token:
--   provider_accounts, strava_accounts, terra_accounts,
--   subscriptions, subscription_events, pending_provider_connections
--
-- Coaches also get NO insert/update/delete on any athlete table, so they can
-- never modify an athlete's identity, plan, or records in this sprint.
