-- Athlevo — Production Readiness Sprint 2: AI endpoint rate limiting.
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
-- Additive, idempotent and non-destructive (safe to run more than once).
--
-- WHY A TABLE (and not an in-memory limiter):
-- Vercel serverless functions scale to many independent instances and are
-- recycled constantly. An in-memory counter would reset per instance and give
-- a FALSE impression of protection — an abuser hitting different instances
-- would never be limited. A tiny Postgres table is the simplest reliable
-- store already present in this stack (no new third-party dependency, no
-- Redis, no extra cost).
--
-- MODEL: fixed window. One row per (user_id, endpoint, window_start).
-- The endpoint atomically increments via upsert and reads back the count.

create table if not exists public.ai_rate_limits (
  user_id uuid not null
    references auth.users (id) on delete cascade,

  -- 'coach' | 'daily-brief' | 'memory-extract'
  endpoint text not null,

  -- Truncated start of the fixed window (e.g. date_trunc('hour', now())).
  window_start timestamptz not null,

  request_count integer not null default 0,

  updated_at timestamptz not null default now(),

  primary key (user_id, endpoint, window_start)
);

create index if not exists ai_rate_limits_window_idx
  on public.ai_rate_limits (window_start);

alter table public.ai_rate_limits enable row level security;

-- No athlete-facing policies: this table is written ONLY by the server
-- (service role, which bypasses RLS). Enabling RLS with no SELECT policy means
-- the anon/authenticated client can never read or tamper with counters.

-- OPERATIONAL NOTE — housekeeping:
-- Old windows are dead weight. Either run this occasionally:
--     delete from public.ai_rate_limits where window_start < now() - interval '7 days';
-- or schedule it with pg_cron if available. Not required for correctness.
