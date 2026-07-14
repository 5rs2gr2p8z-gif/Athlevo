-- Athlevo activity override — canonical numeric pace.
-- Run this MANUALLY in Supabase AFTER 2026-07-14_coach_actions.sql and
-- BEFORE deploying the matching code. Nothing here runs automatically.
--
-- Pace corrections must be stored as ONE canonical number (seconds per
-- kilometer), not only as a display string. corrected_average_pace
-- remains for display; corrected_pace_seconds_per_km is the value all
-- coaching analysis reads. Purely additive; existing rows are unaffected.

alter table public.activity_data_overrides
  add column if not exists corrected_pace_seconds_per_km integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname =
      'activity_data_overrides_corrected_pace_seconds_per_km_check'
  ) then
    alter table public.activity_data_overrides
      add constraint activity_data_overrides_corrected_pace_seconds_per_km_check
      check (
        corrected_pace_seconds_per_km is null
        or corrected_pace_seconds_per_km between 60 and 3600
      );
  end if;
end $$;
