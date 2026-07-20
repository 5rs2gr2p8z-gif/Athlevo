-- Athlevo — Production Readiness Sprint 2: activation funnel events.
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
-- Additive, idempotent and non-destructive (safe to run more than once).
--
-- PURPOSE: answer the activation questions we currently cannot —
--   25 signups → how many completed onboarding? connected Strava? completed a
--   first sync? created a plan? viewed a workout? completed one? used Coach?
--   returned on day 1 / day 7?
--
-- DESIGN
--  · MILESTONE events happen once per athlete, ever. Uniqueness is enforced by
--    a partial unique index so a repeated write is a no-op, not a duplicate.
--  · BEHAVIOURAL events may repeat (e.g. app_opened) and are used to DERIVE
--    returned_day_1 / returned_day_7 by comparing occurred_at to the athlete's
--    account_created date — no separate "returned" event is written.
--  · metadata is small, non-sensitive JSON only. NEVER store tokens, secrets,
--    Coach message content, or precise health data here.

create table if not exists public.activation_events (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  -- Milestone (once per athlete) or behavioural (repeatable).
  event_name text not null
    check (event_name in (
      'account_created',
      'onboarding_completed',
      'strava_connected',
      'first_sync_completed',
      'first_plan_created',
      'first_workout_viewed',
      'first_workout_completed',
      'first_coach_message',
      'app_opened'
    )),

  -- 'milestone' → written once; 'behavioural' → may repeat.
  event_kind text not null default 'milestone'
    check (event_kind in ('milestone', 'behavioural')),

  occurred_at timestamptz not null default now(),

  -- Small, non-sensitive context only (e.g. {"source":"pwa"}).
  metadata jsonb,

  created_at timestamptz not null default now()
);

-- Funnel/report query: per athlete, per event.
create index if not exists activation_events_user_idx
  on public.activation_events (user_id);

create index if not exists activation_events_name_time_idx
  on public.activation_events (event_name, occurred_at desc);

-- Derives returned_day_1 / returned_day_7 efficiently.
create index if not exists activation_events_user_time_idx
  on public.activation_events (user_id, occurred_at desc);

-- ONE row per athlete per MILESTONE event — repeated writes cannot duplicate.
create unique index if not exists activation_events_user_milestone_uidx
  on public.activation_events (user_id, event_name)
  where event_kind = 'milestone';

alter table public.activation_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='activation_events' and cmd='SELECT') then
    create policy "Athletes read own activation events"
      on public.activation_events for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='activation_events' and cmd='INSERT') then
    create policy "Athletes insert own activation events"
      on public.activation_events for insert with check (auth.uid() = user_id);
  end if;
end $$;

-- The server (service role) bypasses RLS to write server-side milestones such
-- as first_sync_completed and first_plan_created.
--
-- FUNNEL QUERY (run manually when you want the numbers):
--   select event_name, count(distinct user_id)
--   from public.activation_events
--   group by event_name order by 2 desc;
--
-- RETURNED DAY 1 / DAY 7 (derived, no extra event needed):
--   with created as (
--     select user_id, min(occurred_at) as t0
--     from public.activation_events
--     where event_name = 'account_created' group by user_id)
--   select
--     count(distinct case when e.occurred_at::date = (c.t0 + interval '1 day')::date
--                         then e.user_id end) as returned_day_1,
--     count(distinct case when e.occurred_at::date = (c.t0 + interval '7 day')::date
--                         then e.user_id end) as returned_day_7
--   from created c
--   join public.activation_events e on e.user_id = c.user_id;
