-- Athlevo — training_sessions.structured_segments (Training Engine V2).
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
-- Additive, idempotent, and backward compatible — it never rewrites or
-- deletes existing plans.
--
-- Stores an OPTIONAL structured segment breakdown for a planned session so
-- Train can render exact, segment-by-segment execution targets (warm-up,
-- main set, recovery, cool-down, strides) instead of prose only. When the
-- column is NULL (all existing plans), the app falls back to generating
-- guidance on the fly from the session type + duration via the workout
-- guidance engine, so nothing breaks.
--
-- Shape (jsonb array), each element may contain:
--   { "kind": "warmup|interval|recovery|steady|threshold|cooldown|strides",
--     "duration_seconds": int, "distance_meters": int,
--     "pace_min_seconds_per_km": int, "pace_max_seconds_per_km": int,
--     "rpe_min": int, "rpe_max": int, "hr_min": int, "hr_max": int,
--     "repetitions": int, "recovery_seconds": int,
--     "instruction": text, "adjustment_rule": text }

alter table public.training_sessions
  add column if not exists structured_segments jsonb;

-- Optional: document intent at the column level (safe, idempotent).
comment on column public.training_sessions.structured_segments is
  'Optional V2 structured workout segments (jsonb array). NULL = generate guidance from type/duration at render time. Additive and backward compatible.';
