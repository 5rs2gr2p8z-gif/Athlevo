-- Athlevo — onboarding/activation funnel events.
--
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
-- Additive and idempotent. It only widens the set of allowed event names;
-- it never deletes a row, never narrows the constraint, and never touches
-- activities, provider_accounts, plans, or any coaching data.
--
-- Depends on 2026-07-20_activation_events.sql. If activation_events does not
-- exist yet, run that one first — this file creates nothing on its own.
--
-- The client writes these events BEST-EFFORT: if the table is absent or a
-- write fails, onboarding continues silently. Analytics must never be able
-- to block an athlete from finishing setup.

do $$
begin
  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'activation_events'
  ) then
    raise notice 'activation_events does not exist — run 2026-07-20_activation_events.sql first. Nothing changed.';
    return;
  end if;

  -- Replace the event_name CHECK with one that also permits the onboarding
  -- funnel events. Dropping and re-adding is the only way to widen a CHECK;
  -- every previously allowed value is retained below, so no existing row can
  -- become invalid.
  alter table public.activation_events
    drop constraint if exists activation_events_event_name_check;

  alter table public.activation_events
    add constraint activation_events_event_name_check
    check (event_name in (
      -- existing
      'account_created',
      'onboarding_completed',
      'strava_connected',
      'first_sync_completed',
      'first_plan_created',
      'first_workout_viewed',
      'first_workout_completed',
      'first_coach_message',
      'app_opened',
      -- onboarding funnel (new)
      'signup_started',
      'signup_completed',
      'profile_completed',
      'connect_step_viewed',
      'intervals_connected',
      'activities_detected',
      'initial_sync_started',
      'initial_sync_completed',
      'dashboard_opened',
      'sync_failed',
      'no_activities'
    ));
end $$;

-- Funnel events are behavioural (a user may retry a step), so the existing
-- one-row-per-milestone unique index must not apply to them. That index is
-- scoped to event_kind = 'milestone'; the client writes funnel events with
-- event_kind = 'behavioural', so no change is required here.

-- RLS: athletes may insert their OWN events and read nothing back. Analytics
-- is written from the client, so an insert policy is required; there is
-- deliberately no select policy.
alter table public.activation_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'activation_events'
      and policyname = 'activation_events_insert_own'
  ) then
    create policy activation_events_insert_own
      on public.activation_events
      for insert
      to authenticated
      with check (auth.uid() = user_id);
  end if;
end $$;
