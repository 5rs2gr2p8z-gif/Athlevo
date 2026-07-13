-- Athlevo workout execution & feedback records.
-- Run this MANUALLY in Supabase BEFORE deploying the matching code.
--
-- Design notes:
--   * This is a SEPARATE table from training_sessions. The generated
--     session is the prescription and is never overwritten by feedback.
--     Each row here is the athlete's report of what actually happened
--     for one planned session (or one rest day).
--   * One current record per (user, training session). Editing feedback
--     is an upsert on that pair, so replacing feedback is deliberate and
--     never leaves duplicates.
--   * original_session_snapshot captures the prescription at the moment
--     feedback is first saved, so later plan regeneration cannot erase
--     what the athlete was actually reacting to.

create table if not exists public.workout_execution_records (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  -- The prescribed session this feedback is about. Nullable so that
  -- ad-hoc "training performed instead" on a rest day still works even
  -- if the rest session row is ever pruned.
  training_session_id uuid
    references public.training_sessions (id) on delete cascade,

  status text not null default 'planned'
    check (status in ('planned', 'completed', 'skipped', 'modified')),

  completed_at timestamptz,

  actual_duration_minutes integer
    check (actual_duration_minutes is null or actual_duration_minutes >= 0),
  actual_distance_km numeric(6,2)
    check (actual_distance_km is null or actual_distance_km >= 0),
  actual_rpe integer
    check (actual_rpe is null or actual_rpe between 1 and 10),

  -- 'easier' | 'as_expected' | 'harder'
  overall_feeling text,

  pain_present boolean not null default false,
  pain_location text,
  pain_severity integer
    check (pain_severity is null or pain_severity between 1 and 10),

  athlete_notes text,

  -- Modify flow: what changed vs. the prescription, and why.
  modification_reason text,

  -- Skip flow: the single main reason (fatigue, pain, illness, schedule,
  -- weather, travel, motivation, other) and whether the athlete wants the
  -- rest of the week adjusted.
  skip_reason text,
  adjust_remaining_week boolean not null default false,

  -- Complete flow: did they run it as prescribed?
  as_prescribed boolean,

  -- The prescription as it stood when feedback was saved.
  original_session_snapshot jsonb,

  -- Matching Strava activity, when one was used to prefill / confirm.
  imported_activity_id uuid
    references public.activities (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One live feedback record per prescribed session.
  unique (user_id, training_session_id)
);

-- ─── indexes ────────────────────────────────────────────────────

create index if not exists workout_execution_records_user_idx
  on public.workout_execution_records (user_id);

create index if not exists workout_execution_records_session_idx
  on public.workout_execution_records (training_session_id);

create index if not exists workout_execution_records_user_status_idx
  on public.workout_execution_records (user_id, status);

create index if not exists workout_execution_records_completed_at_idx
  on public.workout_execution_records (user_id, completed_at desc);

-- ─── row level security (user-owned) ────────────────────────────

alter table public.workout_execution_records enable row level security;

create policy "Athletes read own execution records"
  on public.workout_execution_records for select
  using (auth.uid() = user_id);

create policy "Athletes insert own execution records"
  on public.workout_execution_records for insert
  with check (auth.uid() = user_id);

create policy "Athletes update own execution records"
  on public.workout_execution_records for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Athletes delete own execution records"
  on public.workout_execution_records for delete
  using (auth.uid() = user_id);

-- The server (service role) bypasses RLS to read these records when it
-- builds coaching context for weekly analysis, plan generation, the
-- daily brief, and Coach Chat.
