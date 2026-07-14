-- Athlevo Daily Readiness.
-- Run this MANUALLY in Supabase BEFORE deploying the matching code.
-- Nothing here runs automatically.
--
-- Daily Readiness is coaching input, not a wellness log: the athlete's
-- own read on how their body feels today, paired with objective training
-- data by the coach. One record per athlete per calendar day (the unique
-- constraint + a client upsert prevent duplicates). No fabricated
-- readiness/HRV/recovery score is ever stored — only what the athlete
-- actually reported.

create table if not exists public.daily_readiness (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  readiness_date date not null,

  -- 1 (Very poor) … 5 (Excellent)
  sleep_quality smallint
    check (sleep_quality is null or sleep_quality between 1 and 5),

  -- 1 … 10
  energy smallint
    check (energy is null or energy between 1 and 10),
  muscle_soreness smallint
    check (muscle_soreness is null or muscle_soreness between 1 and 10),
  mental_stress smallint
    check (mental_stress is null or mental_stress between 1 and 10),

  pain_present boolean not null default false,
  pain_location text,
  pain_severity smallint
    check (pain_severity is null or pain_severity between 1 and 10),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One readiness record per athlete per day.
  unique (user_id, readiness_date)
);

create index if not exists daily_readiness_user_idx
  on public.daily_readiness (user_id);

create index if not exists daily_readiness_user_date_idx
  on public.daily_readiness (user_id, readiness_date desc);

alter table public.daily_readiness enable row level security;

create policy "Athletes read own readiness"
  on public.daily_readiness for select
  using (auth.uid() = user_id);

create policy "Athletes insert own readiness"
  on public.daily_readiness for insert
  with check (auth.uid() = user_id);

create policy "Athletes update own readiness"
  on public.daily_readiness for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- The server (service role) bypasses RLS to read readiness when it builds
-- coaching context for the daily brief, weekly analysis, coach chat, and
-- plan generation.
