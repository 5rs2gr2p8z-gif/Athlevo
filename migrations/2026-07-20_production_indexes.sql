-- Athlevo — Production Readiness Sprint 2: scaling indexes.
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
-- Additive, idempotent and non-destructive (safe to run more than once).
--
-- WHY: `activities` and `training_sessions` were created before this
-- migrations directory existed, so they carry no index migration here. Every
-- production screen filters those tables by user_id + a date range:
--
--   activities         → user_id = ? AND start_date BETWEEN ? AND ?   (Today,
--                        Trends, Train calendar, Score, Coach context)
--   training_sessions  → user_id = ? AND session_date BETWEEN ? AND ? (Train
--                        calendar week navigation, get-week, generate-plan)
--
-- Without these, each read is a sequential scan of the athlete's whole
-- history. At 1,000 athletes × 1,000+ activities that is the first thing to
-- fall over. CONCURRENTLY is NOT used so this stays inside one transaction and
-- is safe to run from the SQL editor; these tables are small enough today that
-- the brief lock is acceptable. If a table has grown very large, run the
-- CONCURRENTLY variants noted at the bottom instead (outside a transaction).

-- ── activities ────────────────────────────────────────────────────────
create index if not exists activities_user_start_idx
  on public.activities (user_id, start_date desc);

-- Sync/import dedup path: upserts resolve on (source, external_activity_id).
create index if not exists activities_user_external_idx
  on public.activities (user_id, source, external_activity_id);

-- ── training_sessions ─────────────────────────────────────────────────
create index if not exists training_sessions_user_date_idx
  on public.training_sessions (user_id, session_date);

-- Plan-generation idempotency guard looks up an existing week directly.
create index if not exists training_sessions_user_week_idx
  on public.training_sessions (user_id, plan_week_start);

-- ── already covered by earlier migrations (listed for completeness) ───
--   workout_execution_records (training_session_id) → workout_execution_records_session_idx
--   workout_execution_records (user_id)             → workout_execution_records_user_idx
--   race_results (user_id), (user_id, race_date)    → race_results_user_idx / _user_date_idx
--   athlevo_score_history (user_id), (user_id,date) → athlevo_score_history_user_idx / _user_date_idx
--   strava_accounts (user_id) unique                → strava_accounts_user_id_uidx
--   strava_accounts (athlete id) unique             → strava_accounts_athlete_uidx
-- No action needed for those.

-- ── very large tables only (run OUTSIDE a transaction, one at a time) ──
-- create index concurrently if not exists activities_user_start_idx
--   on public.activities (user_id, start_date desc);
-- create index concurrently if not exists training_sessions_user_date_idx
--   on public.training_sessions (user_id, session_date);
