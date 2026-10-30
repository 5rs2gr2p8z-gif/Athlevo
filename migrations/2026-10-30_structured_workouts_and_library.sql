-- Athlevo — structured workouts + coach workout library.
-- Apply manually in the Supabase SQL editor after review. ADDITIVE ONLY:
-- it adds one nullable column and one new table, changes no existing data and
-- no existing policy. The app keeps working if this has not been applied:
--   · saving a built workout still works (it just cannot be re-opened in the builder)
--   · the library shows "not set up yet" instead of an empty list.

-- 1. The builder's steps, stored on the scheduled session so a coach can re-open
--    and edit them. The readable fields the rest of the app uses (warmup,
--    main_set, cooldown, duration_minutes, distance_km, pace_guidance) are still
--    written alongside it, so athlete screens need no change.
alter table public.training_sessions
  add column if not exists structure jsonb;

-- 2. A coach's reusable workouts. Targets are stored as zones, never as one
--    athlete's paces, so the same library workout shows every athlete their own.
create table if not exists public.coach_workout_library (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  folder      text check (folder is null or char_length(folder) <= 80),
  sport       text not null default 'run',
  structure   jsonb not null,
  summary     jsonb,
  notes       text check (notes is null or char_length(notes) <= 600),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists coach_workout_library_coach_idx
  on public.coach_workout_library (coach_id, folder, updated_at desc);

alter table public.coach_workout_library enable row level security;

-- Intentionally no authenticated policies: RLS default-denies every browser
-- read and write. All access goes through the service-role gateway
-- (api/providers coaching_library_*), which re-verifies the coach role and
-- always scopes every query to the authenticated coach_id.
