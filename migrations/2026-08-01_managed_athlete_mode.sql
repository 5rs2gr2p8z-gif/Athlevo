-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — Managed Athlete Mode: plan authority, change requests, transition
-- ══════════════════════════════════════════════════════════════════════
--
--  Run MANUALLY in Supabase AFTER review. Nothing here runs automatically.
--  ADDITIVE and non-destructive: it adds columns (with safe defaults that
--  preserve today's behaviour), two small tables, and RLS. It does NOT
--  rewrite historical rows and does NOT change who owns existing plans until
--  a coach assignment + a transition explicitly do so.
--
--  Prerequisite: migrations/2026-08-01_coach_dashboard.sql (roles + assignments).

-- ─────────────────────────────────────────────────────────────────────
--  1. Plan authorship on training_sessions
-- ─────────────────────────────────────────────────────────────────────
-- `source` already exists ('ai_generated'). Add explicit ownership so an
-- authoritative owner can be identified per session. Default 'athlete_ai' keeps
-- every existing AI-generated session behaving exactly as it does today.
alter table public.training_sessions
  add column if not exists owner_type text not null default 'athlete_ai';

alter table public.training_sessions
  drop constraint if exists training_sessions_owner_type_check;
alter table public.training_sessions
  add constraint training_sessions_owner_type_check
  check (owner_type in ('athlete_ai', 'human_coach', 'athlete', 'system'));

alter table public.training_sessions
  add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table public.training_sessions
  add column if not exists updated_by uuid references auth.users (id) on delete set null;
-- A coach-owned session that an AI/athlete change must not silently alter.
alter table public.training_sessions
  add column if not exists requires_coach_approval boolean not null default false;

create index if not exists training_sessions_owner_idx
  on public.training_sessions (user_id, owner_type);

-- ─────────────────────────────────────────────────────────────────────
--  2. Managed plan change requests (proposals & athlete requests)
-- ─────────────────────────────────────────────────────────────────────
-- When an athlete is human-coached, an AI-generated change becomes a
-- 'ai_proposal' and an athlete-originated change becomes an 'athlete_request'.
-- Neither is applied to a coach-owned session until an authorized active coach
-- approves it. The coach-owned plan is never silently mutated.
create table if not exists public.managed_plan_change_requests (
  id            uuid primary key default gen_random_uuid(),
  athlete_id    uuid not null references auth.users (id) on delete cascade,
  coach_id      uuid references auth.users (id) on delete set null,
  session_date  date,
  origin        text not null check (origin in ('ai_proposal', 'athlete_request')),
  request_type  text not null,          -- categorical: 'adjustment','unable_to_complete','move','feedback',…
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'applied', 'declined', 'withdrawn')),
  payload       jsonb,                  -- proposed change (no PII beyond training content)
  created_by    uuid references auth.users (id) on delete set null,
  reviewed_by   uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  updated_at    timestamptz not null default now()
);

create index if not exists mpcr_athlete_idx
  on public.managed_plan_change_requests (athlete_id, status, created_at desc);
create index if not exists mpcr_coach_idx
  on public.managed_plan_change_requests (coach_id, status, created_at desc);

alter table public.managed_plan_change_requests enable row level security;

-- Athlete reads their own requests/proposals.
drop policy if exists "Athlete reads own change requests" on public.managed_plan_change_requests;
create policy "Athlete reads own change requests"
  on public.managed_plan_change_requests for select
  using (auth.uid() = athlete_id);

-- Athlete may CREATE only an athlete_request about themselves (never an
-- ai_proposal, never for another athlete). AI proposals are inserted by the
-- server (service role) after mode + authority checks.
drop policy if exists "Athlete creates own adjustment request" on public.managed_plan_change_requests;
create policy "Athlete creates own adjustment request"
  on public.managed_plan_change_requests for insert
  with check (auth.uid() = athlete_id and origin = 'athlete_request');

-- Assigned ACTIVE coach reads requests for their athletes.
drop policy if exists "Coach reads assigned athlete change requests" on public.managed_plan_change_requests;
create policy "Coach reads assigned athlete change requests"
  on public.managed_plan_change_requests for select
  using (public.athlevo_is_active_coach_of(athlete_id));

-- Approvals/applies are performed by the server (service role) after it
-- re-verifies an ACTIVE assignment. No broad client update policy is granted.

-- ─────────────────────────────────────────────────────────────────────
--  3. Coaching transition state (adopt / replace / start-after)
-- ─────────────────────────────────────────────────────────────────────
-- Records the safe handoff when an assignment becomes active while an AI plan
-- exists. Until resolved, the athlete UI shows a transition state and never two
-- authoritative workouts for the same date.
create table if not exists public.coaching_transitions (
  id            uuid primary key default gen_random_uuid(),
  athlete_id    uuid not null references auth.users (id) on delete cascade,
  coach_id      uuid not null references auth.users (id) on delete cascade,
  assignment_id uuid references public.coach_athlete_assignments (id) on delete cascade,
  state         text not null default 'pending_coach_choice'
                  check (state in ('pending_coach_choice', 'adopt_existing', 'replace_from_date', 'start_after_week', 'resolved')),
  effective_date date,                  -- for replace_from_date / start_after_week
  ai_plan_detected boolean not null default false,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  updated_at    timestamptz not null default now()
);

-- One live transition per athlete–coach pair.
create unique index if not exists coaching_transitions_live_unique
  on public.coaching_transitions (athlete_id, coach_id)
  where state <> 'resolved';

alter table public.coaching_transitions enable row level security;

drop policy if exists "Athlete reads own transition" on public.coaching_transitions;
create policy "Athlete reads own transition"
  on public.coaching_transitions for select
  using (auth.uid() = athlete_id);

drop policy if exists "Coach reads assigned transition" on public.coaching_transitions;
create policy "Coach reads assigned transition"
  on public.coaching_transitions for select
  using (public.athlevo_is_active_coach_of(athlete_id));

-- Transitions are created/resolved by the server (service role) as part of the
-- (future) invitation-acceptance flow; no broad client write policy is granted.

-- ─────────────────────────────────────────────────────────────────────
--  Notes
-- ─────────────────────────────────────────────────────────────────────
-- · Existing self-guided athletes are unaffected: owner_type defaults to
--   'athlete_ai', no assignment exists, so coaching mode resolves self_guided
--   and every current AI write path behaves as before.
-- · Coaches still get NO access to provider_accounts/subscriptions (unchanged).
-- · Historical authorship is preserved: created_by/updated_by/owner_type are
--   only set going forward; no historical row is rewritten by this migration.
