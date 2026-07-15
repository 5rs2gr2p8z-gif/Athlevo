-- Athlevo Performance Foundation — race_results.
-- Run this MANUALLY in Supabase BEFORE deploying the matching code.
-- Nothing here runs automatically. Additive and idempotent (safe to
-- run more than once).
--
-- This table stores ONLY RAW race inputs — the distance, the time, the
-- date, and how the effort was classified. It deliberately stores NO
-- derived value: VDOT, Current Running Level, training paces and the
-- Athlevo Score are all recomputed on demand from these rows (plus the
-- athlete's activities and profile) by the shared performance engine
-- (lib/server/performance.js / js/performance.js). Keeping the database
-- free of derived numbers means the fitness model can be improved later
-- with no data migration.
--
-- Rows arrive from three places, all recorded the same way:
--   · source = 'onboarding'  — the recent race the athlete typed during
--                              onboarding (optional).
--   · source = 'strava'      — an imported activity the athlete CONFIRMED
--                              was a race (automatic detection only ever
--                              proposes; the athlete confirms).
--   · source = 'manual'      — reserved for a future "log a race" action.
--
-- race_type carries the athlete's classification. Only 'official',
-- 'time_trial' and 'training_effort' are treated as fitness-eligible by
-- the engine; 'hard_workout' and 'not_a_race' are stored so a dismissed
-- activity is never re-proposed by detection.

create table if not exists public.race_results (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  -- Where this result came from.
  source text not null
    check (source in ('onboarding', 'strava', 'manual')),

  -- When source = 'strava', the id of the imported activity this result
  -- was confirmed from. Kept as text to mirror the existing
  -- imported_activity_id convention on workout_execution_records; no hard
  -- FK so activity-table changes can never block a confirmation.
  activity_id text,

  -- Athlete's classification of the effort.
  race_type text not null
    check (race_type in (
      'official', 'time_trial', 'training_effort',
      'hard_workout', 'not_a_race'
    )),

  -- Raw result. distance + duration are all the engine needs for VDOT.
  distance_meters numeric not null
    check (distance_meters > 0),
  duration_seconds integer
    check (duration_seconds is null or duration_seconds > 0),

  race_date date,

  -- Optional provenance for a detected race: the raw detection confidence
  -- (0–100) at confirmation time. Not a fitness value — never fed back
  -- into the model — just useful context. Safe to ignore.
  detection_confidence smallint
    check (detection_confidence is null or detection_confidence between 0 and 100),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists race_results_user_idx
  on public.race_results (user_id);

create index if not exists race_results_user_date_idx
  on public.race_results (user_id, race_date desc);

-- One confirmation per imported activity: a repeated confirm/dismiss on
-- the same Strava activity updates the same row instead of duplicating.
create unique index if not exists race_results_user_activity_uidx
  on public.race_results (user_id, activity_id)
  where activity_id is not null;

alter table public.race_results enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='race_results' and cmd='SELECT') then
    create policy "Athletes read own race results"
      on public.race_results for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='race_results' and cmd='INSERT') then
    create policy "Athletes insert own race results"
      on public.race_results for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='race_results' and cmd='UPDATE') then
    create policy "Athletes update own race results"
      on public.race_results for update
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='race_results' and cmd='DELETE') then
    create policy "Athletes delete own race results"
      on public.race_results for delete using (auth.uid() = user_id);
  end if;
end $$;

-- The server (service role) bypasses RLS to read race_results when it
-- derives Current Running Level and training paces for plan generation.
