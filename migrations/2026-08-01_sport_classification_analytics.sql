-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — Multi-sport classification analytics taxonomy
-- ══════════════════════════════════════════════════════════════════════
--
--  The multi-sport activity classification sprint introduces three new
--  categorical events (see js/analyticsRegistry.js):
--    · activity_classified     — every imported activity's canonical sport
--    · activity_type_unmapped  — a provider type we could not map (→ other)
--    · sport_filter_viewed     — user filtered history/summary by sport
--
--  This migration widens the activation_events CHECK constraint to accept
--  them. It reproduces the full existing allow-list (Postgres CHECK cannot be
--  extended in place) and appends the three names.
--
--  Analytics-only. No product table is touched. Client persistence fails
--  silently until this runs, so deploying app code before the migration is
--  safe. NOT YET APPLIED — apply in Supabase during the deploy, not from the
--  sandbox.

alter table public.activation_events
  drop constraint if exists activation_events_event_name_check;

alter table public.activation_events
  add constraint activation_events_event_name_check
  check (event_name in (
    -- canonical taxonomy
    'account_created',
    'email_verified',
    'athlete_onboarding_started',
    'athlete_onboarding_completed',
    'wearable_setup_started',
    'sync_account_step_viewed',
    'wearable_provider_step_viewed',
    'wearable_connection_succeeded',
    'wearable_connection_failed',
    'first_sync_started',
    'first_activity_imported',
    'activity_imported',
    'first_workout_analysis_viewed',
    'plan_generation_started',
    'first_plan_generated',
    'plan_generation_failed',
    'coach_opened',
    'first_coach_message_sent',
    'adaptive_plan_reviewed',
    'adaptive_plan_applied',
    'app_session_started',
    'primary_tab_viewed',
    -- multi-sport classification taxonomy (this sprint)
    'activity_classified',
    'activity_type_unmapped',
    'sport_filter_viewed',
    -- retained legacy names (older rows / older clients)
    'onboarding_completed', 'strava_connected', 'first_sync_completed',
    'first_plan_created', 'first_workout_viewed', 'first_workout_completed',
    'first_coach_message', 'app_opened', 'signup_started', 'signup_completed',
    'profile_completed', 'connect_step_viewed', 'intervals_connected',
    'activities_detected', 'initial_sync_started', 'initial_sync_completed',
    'dashboard_opened', 'sync_failed', 'no_activities'
  ));

-- ──────────────────────────────────────────────────────────────────────
--  RECOMMENDED (NOT IMPLEMENTED THIS SPRINT) — athlete sport profile.
--  Classification does not depend on onboarding (provider type is the signal),
--  and `profiles.primary_sport` already exists, so no schema change is required
--  for safe multi-sport classification now. When cycling plan generation is
--  built, add:
--
--    alter table public.profiles
--      add column if not exists secondary_sport text,
--      add column if not exists goal_sport text,          -- running|cycling|duathlon|triathlon|general_endurance
--      add column if not exists cycling_ftp_watts integer,          -- optional
--      add column if not exists cycling_threshold_hr integer,       -- optional
--      add column if not exists has_power_meter boolean,
--      add column if not exists has_indoor_trainer boolean,
--      add column if not exists weekly_riding_hours numeric,
--      add column if not exists longest_recent_ride_km numeric,
--      add column if not exists preferred_ride_days text,
--      add column if not exists target_event_type text,
--      add column if not exists target_event_date date;
-- ──────────────────────────────────────────────────────────────────────
