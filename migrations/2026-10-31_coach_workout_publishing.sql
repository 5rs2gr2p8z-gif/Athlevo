-- Coach workout publishing (V.O2-style draft -> publish)
-- ─────────────────────────────────────────────────────────────────────────────
-- A coach builds workouts on an athlete's calendar as DRAFTS that only the coach
-- can see, then PUBLISHES them (one, a week, or all) to release them to the
-- athlete. This mirrors the publish workflow coaches already know from V.O2.
--
-- Additive and backward compatible:
--   • coach_draft defaults to FALSE, so every workout that already exists — and
--     every workout the AI planner writes — is treated as published/visible.
--     No athlete loses training they can already see.
--   • If this migration has not been run yet, the app still works: the server
--     and client fall back to writing/reading without these columns, so new
--     coach workouts are simply visible immediately (the old behaviour).
--
-- Run this in Supabase, then deploy. Safe to run more than once.

alter table public.training_sessions
  add column if not exists coach_draft  boolean not null default false,
  add column if not exists published_at  timestamptz;

-- Stamp a publish time on everything that is already visible (nice for display;
-- visibility itself is decided by coach_draft = false).
update public.training_sessions
   set published_at = coalesce(published_at, created_at, now())
 where coach_draft = false
   and published_at is null;

-- The athlete's calendar only ever reads the visible (non-draft) rows.
create index if not exists training_sessions_user_visible
  on public.training_sessions (user_id, session_date)
  where coach_draft = false;
