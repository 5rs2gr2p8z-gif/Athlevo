-- Athlevo — athlete_metrics (Phase B Athlete Engine).
-- Run this MANUALLY in Supabase BEFORE deploying the matching code.
-- Nothing here runs automatically. Additive and idempotent (safe to run
-- more than once).
--
-- A single CURRENT snapshot per athlete of the metrics produced by the
-- Athlete Engine (lib/server/athleteEngine.js / js/athleteEngine.js). It
-- is a cache of DERIVED values so every screen and the AI coach can read
-- the same numbers cheaply — it is not an authoritative source. All of it
-- is recomputable from raw data (activities, execution records, confirmed
-- races) at any time, so the model can be improved without a migration.
--
-- One row per user (upsert on user_id). Scores are NULL while a component
-- is still "Building" — a missing quality is never stored as zero.
-- Historical VDOT lives in race_results (each confirmed race is raw VDOT
-- evidence), so no separate history table is introduced here.

create table if not exists public.athlete_metrics (
  user_id uuid primary key
    references auth.users (id) on delete cascade,

  -- Fitness (from the shared VDOT engine)
  current_vdot        numeric(5,1),
  estimated_vo2max    numeric(5,1),

  -- Composite component scores (0–100, or NULL while Building)
  aerobic_score       smallint check (aerobic_score   is null or aerobic_score   between 0 and 100),
  threshold_score     smallint check (threshold_score is null or threshold_score between 0 and 100),
  speed_score         smallint check (speed_score     is null or speed_score     between 0 and 100),
  endurance_score     smallint check (endurance_score is null or endurance_score between 0 and 100),
  fatigue_score       smallint check (fatigue_score   is null or fatigue_score   between 0 and 100),
  fitness_score       smallint check (fitness_score   is null or fitness_score   between 0 and 100),
  athlevo_score       smallint check (athlevo_score   is null or athlevo_score   between 0 and 100),

  -- Volume / consistency
  weekly_training_load integer,
  weekly_distance      numeric(7,1),
  weekly_duration      integer,          -- minutes

  -- Recovery / load model (wearable-free)
  acute_load           integer,
  chronic_load         integer,
  training_monotony    numeric(5,2),
  training_strain      integer,

  last_updated         timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

create index if not exists athlete_metrics_updated_idx
  on public.athlete_metrics (last_updated desc);

alter table public.athlete_metrics enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlete_metrics' and cmd='SELECT') then
    create policy "Athletes read own metrics"
      on public.athlete_metrics for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlete_metrics' and cmd='INSERT') then
    create policy "Athletes insert own metrics"
      on public.athlete_metrics for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlete_metrics' and cmd='UPDATE') then
    create policy "Athletes update own metrics"
      on public.athlete_metrics for update
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlete_metrics' and cmd='DELETE') then
    create policy "Athletes delete own metrics"
      on public.athlete_metrics for delete using (auth.uid() = user_id);
  end if;
end $$;

-- The server (service role) bypasses RLS to recompute and upsert metrics
-- after an import and to read them when building coaching context.
