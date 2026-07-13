-- Athlevo workout execution — additional actual-performance fields.
-- Run this MANUALLY in Supabase AFTER the base execution table migration
-- (2026-07-13_workout_execution_records.sql) and BEFORE deploying the
-- matching code. Nothing here runs automatically.
--
-- These columns are purely additive so existing execution records and
-- the working feedback flow remain valid. They capture the athlete's
-- (optionally Strava-prefilled) average pace and heart rate, and record
-- when the athlete deliberately overrode the auto-suggested activity
-- match. Naming aligns with the existing table:
--   * matched_strava_activity_id already exists as imported_activity_id
--   * coach_adjustment_requested already exists as adjust_remaining_week

alter table public.workout_execution_records
  add column if not exists actual_average_pace text,
  add column if not exists actual_average_hr integer,
  add column if not exists manual_activity_override boolean not null default false;

-- Guard rails (added separately so re-running is safe).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workout_execution_records_actual_average_hr_check'
  ) then
    alter table public.workout_execution_records
      add constraint workout_execution_records_actual_average_hr_check
      check (actual_average_hr is null or actual_average_hr between 20 and 260);
  end if;
end $$;
