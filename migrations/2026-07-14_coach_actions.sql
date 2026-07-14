-- Athlevo structured coach actions & activity data corrections.
-- Run this MANUALLY in Supabase BEFORE deploying the matching code.
-- Nothing here runs automatically.
--
-- Design:
--   * coach_action_proposals records every structured change the coach
--     proposes from a chat message. Nothing is applied until the athlete
--     confirms; the row's status moves pending -> applied | cancelled.
--     The id is client-generated so a repeated "Apply" tap is idempotent.
--   * activity_data_overrides holds athlete-confirmed corrections to an
--     imported activity. The raw Strava row in `activities` is NEVER
--     modified; coaching reads the override where present and otherwise
--     falls back to the raw value.

-- ─── 1. Coach action proposals ──────────────────────────────────

create table if not exists public.coach_action_proposals (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  -- Where the proposal came from (best-effort; both nullable).
  source_conversation_id text,
  source_message_id text,

  action_type text not null
    check (action_type in (
      'modify_workout',
      'move_workout',
      'skip_workout',
      'replace_workout',
      'adjust_remaining_week',
      'update_temporary_availability',
      'update_training_preference',
      'create_activity_override',
      'update_race_details'
    )),

  status text not null default 'pending'
    check (status in ('pending', 'applied', 'cancelled')),

  -- Sessions this proposal touches (array of training_sessions.id).
  affected_session_ids jsonb not null default '[]'::jsonb,

  -- The validated change set the athlete is confirming.
  proposed_changes jsonb,

  -- The prescription/values as they stood before applying.
  original_snapshot jsonb,

  -- For activity corrections: the athlete-confirmed values.
  corrected_values jsonb,

  reason text,

  confirmed_at timestamptz,
  applied_at timestamptz,
  cancelled_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists coach_action_proposals_user_idx
  on public.coach_action_proposals (user_id);

create index if not exists coach_action_proposals_user_status_idx
  on public.coach_action_proposals (user_id, status);

create index if not exists coach_action_proposals_created_idx
  on public.coach_action_proposals (user_id, created_at desc);

alter table public.coach_action_proposals enable row level security;

create policy "Athletes read own proposals"
  on public.coach_action_proposals for select
  using (auth.uid() = user_id);

create policy "Athletes insert own proposals"
  on public.coach_action_proposals for insert
  with check (auth.uid() = user_id);

create policy "Athletes update own proposals"
  on public.coach_action_proposals for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─── 2. Activity data overrides ─────────────────────────────────

create table if not exists public.activity_data_overrides (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  -- The imported activity being corrected. The raw row is never changed.
  activity_id uuid not null
    references public.activities (id) on delete cascade,

  source_proposal_id uuid
    references public.coach_action_proposals (id) on delete set null,

  corrected_distance_km numeric(6,2)
    check (corrected_distance_km is null or corrected_distance_km >= 0),
  corrected_duration_minutes integer
    check (corrected_duration_minutes is null or corrected_duration_minutes >= 0),
  corrected_average_pace text,
  corrected_activity_type text,
  corrected_workout_structure text,
  corrected_perceived_effort integer
    check (corrected_perceived_effort is null or corrected_perceived_effort between 1 and 10),
  corrected_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One live correction per imported activity.
  unique (user_id, activity_id)
);

create index if not exists activity_data_overrides_user_idx
  on public.activity_data_overrides (user_id);

create index if not exists activity_data_overrides_activity_idx
  on public.activity_data_overrides (activity_id);

alter table public.activity_data_overrides enable row level security;

create policy "Athletes read own activity overrides"
  on public.activity_data_overrides for select
  using (auth.uid() = user_id);

create policy "Athletes insert own activity overrides"
  on public.activity_data_overrides for insert
  with check (auth.uid() = user_id);

create policy "Athletes update own activity overrides"
  on public.activity_data_overrides for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- The server (service role) bypasses RLS to read overrides and applied
-- proposals when it builds coaching context for the daily brief, weekly
-- analysis, trends, coach chat, and plan generation.
