-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — Beta analytics taxonomy (expand activation_events event names)
-- ══════════════════════════════════════════════════════════════════════
--
--  The original activation_events CHECK allowed only 9 legacy event names.
--  The Beta Analytics sprint introduces the canonical funnel taxonomy
--  (js/analyticsRegistry.js). This migration replaces the CHECK with the full
--  canonical list so the (best-effort, already-silent) client writes are
--  accepted. RLS, indexes, and the milestone unique index are unchanged.
--
--  Analytics-only. No product table is touched. Client persistence fails
--  silently until this runs, so deploying before the migration is safe.

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
    -- retained legacy names (older rows / older clients)
    'onboarding_completed', 'strava_connected', 'first_sync_completed',
    'first_plan_created', 'first_workout_viewed', 'first_workout_completed',
    'first_coach_message', 'app_opened', 'signup_started', 'signup_completed',
    'profile_completed', 'connect_step_viewed', 'intervals_connected',
    'activities_detected', 'initial_sync_started', 'initial_sync_completed',
    'dashboard_opened', 'sync_failed', 'no_activities'
  ));

-- ADMIN ACCESS
-- The admin analytics endpoint (api/admin/analytics.js) authorizes callers
-- server-side against the ADMIN_USER_IDS env var (comma-separated Supabase
-- auth user UUIDs). No admin role column is added; there is no client-only
-- gating. Set ADMIN_USER_IDS in the Vercel project environment.
