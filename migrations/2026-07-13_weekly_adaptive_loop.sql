-- Athlevo weekly adaptive coaching loop.
-- Run manually in Supabase BEFORE deploying the matching code.
--
-- Adds:
--   1. weekly_check_ins            — athlete end-of-week check-in
--   2. weekly_progress_summaries   — server-computed weekly analysis
--   3. training_plans.adaptation   — what changed / why / kept stable

-- ─── 1. Weekly check-ins ────────────────────────────────────────

create table if not exists public.weekly_check_ins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  week_start date not null,
  created_at timestamptz not null default now(),

  -- 1 (best/lowest) … 5 (worst/highest) unless noted
  overall_fatigue smallint
    check (overall_fatigue between 1 and 5),          -- 1 fresh … 5 exhausted
  sleep_quality smallint
    check (sleep_quality between 1 and 5),            -- 1 poor … 5 excellent
  muscle_soreness smallint
    check (muscle_soreness between 1 and 5),          -- 1 none … 5 severe
  motivation smallint
    check (motivation between 1 and 5),               -- 1 low … 5 high
  stress_level smallint
    check (stress_level between 1 and 5),             -- 1 calm … 5 very high
  perceived_training_load smallint
    check (perceived_training_load between 1 and 10), -- session-RPE style
  pain_or_injury boolean not null default false,
  pain_details text,
  sessions_felt text,                                 -- e.g. "About right"
  confidence_for_next_week smallint
    check (confidence_for_next_week between 1 and 5), -- 1 low … 5 high
  athlete_notes text,
  submitted_at timestamptz,

  unique (user_id, week_start)
);

alter table public.weekly_check_ins enable row level security;

create policy "Athletes read own check-ins"
  on public.weekly_check_ins for select
  using (auth.uid() = user_id);

create policy "Athletes insert own check-ins"
  on public.weekly_check_ins for insert
  with check (auth.uid() = user_id);

create policy "Athletes update own check-ins"
  on public.weekly_check_ins for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─── 2. Weekly progress summaries ───────────────────────────────

create table if not exists public.weekly_progress_summaries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  week_start date not null,
  week_end date,

  planned_sessions integer,
  completed_sessions integer,
  completion_rate numeric(4,3),          -- 0.000 … 1.000
  planned_duration_minutes integer,
  completed_duration_minutes integer,
  planned_distance_km numeric(6,1),
  completed_distance_km numeric(6,1),

  comparable_run_count integer,
  pace_change_seconds_per_km numeric(6,1),  -- null when insufficient
  heart_rate_change_bpm numeric(5,1),       -- null when insufficient

  training_load_direction text,          -- increasing | stable | decreasing | insufficient_data
  consistency_status text,               -- consistent | developing | sparse | insufficient_data
  recovery_status text,                  -- good | fair | poor | unknown
  injury_risk_status text,               -- none_reported | monitor | elevated
  trajectory_status text,                -- ahead | on_track | caution | at_risk | insufficient_data
  confidence_score numeric(4,3),         -- 0.000 … 1.000

  progress_narrative text,
  key_wins jsonb not null default '[]'::jsonb,
  key_concerns jsonb not null default '[]'::jsonb,
  next_week_priorities jsonb not null default '[]'::jsonb,
  details jsonb,                         -- structured evidence (matched sessions, comparable pairs)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, week_start)
);

alter table public.weekly_progress_summaries enable row level security;

create policy "Athletes read own weekly summaries"
  on public.weekly_progress_summaries for select
  using (auth.uid() = user_id);

-- Summaries are written by the server (service role bypasses RLS).

-- ─── 3. Plan adaptation explanation ─────────────────────────────

alter table public.training_plans
  add column if not exists adaptation jsonb;
