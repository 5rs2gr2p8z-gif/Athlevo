-- Adds the new session fields required by the upgraded
-- weekly-plan session schema in api/training/generate-plan.js.
-- Run this in Supabase BEFORE deploying the updated function,
-- otherwise inserts into training_sessions will fail with
-- "column not found".

alter table public.training_sessions
  add column if not exists day text,
  add column if not exists description text,
  add column if not exists target_rpe text,
  add column if not exists notes text;
