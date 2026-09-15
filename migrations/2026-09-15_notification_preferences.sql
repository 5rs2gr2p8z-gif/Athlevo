-- Athlevo — Phase 1 notification preferences (local training reminders only).
-- Run this MANUALLY in Supabase BEFORE deploying the matching client code.
-- Nothing here runs automatically.
--
-- Scope: Phase 1 ships native on-device local scheduling only (no server
-- push, no device tokens, no delivery log — those are Phase 2). This table
-- is deliberately the ONLY new table Phase 1 needs: one row per athlete
-- holding the toggles and reminder time that js/notifications.js reads to
-- decide what to schedule on-device. A dedicated table (rather than adding
-- columns to `profiles`) matches the existing convention of one small,
-- purpose-scoped, RLS-owned table per feature area (see coach_notes,
-- coach_action_proposals) instead of widening the already-large profiles
-- table with a feature that may grow its own columns in Phase 2.

create table if not exists public.notification_preferences (
  user_id uuid primary key
    references auth.users (id) on delete cascade,

  -- Master switch. Starts false: Phase 1 never enables notifications by
  -- itself — only an explicit "Enable reminders" tap (soft-ask accepted +
  -- OS permission granted) or a Settings toggle sets this true.
  notifications_enabled boolean not null default false,

  workout_reminders_enabled  boolean not null default true,
  recovery_reminders_enabled boolean not null default true,

  -- Local time-of-day the reminder fires, evening before the training day
  -- (default 7:00 PM). Stored as text "HH:MM" (24h) — simple, and avoids
  -- timezone ambiguity that a `time` column's display can introduce.
  reminder_time_local text not null default '19:00'
    check (reminder_time_local ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),

  -- IANA timezone captured from the device at the time preferences were
  -- last saved. Used only to interpret reminder_time_local; not a user-
  -- facing setting in Phase 1.
  timezone text not null default 'Asia/Manila',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists notification_preferences_updated_idx
  on public.notification_preferences (updated_at desc);

alter table public.notification_preferences enable row level security;

create policy "Athletes read own notification preferences"
  on public.notification_preferences for select
  using (auth.uid() = user_id);

create policy "Athletes insert own notification preferences"
  on public.notification_preferences for insert
  with check (auth.uid() = user_id);

create policy "Athletes update own notification preferences"
  on public.notification_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Athletes delete own notification preferences"
  on public.notification_preferences for delete
  using (auth.uid() = user_id);

-- Deliberately NOT created in Phase 1 (belong to Phase 2 server-push work):
--   notification_devices   (push tokens)
--   notification_schedule  (server-side scheduled sends)
--   notification_log       (delivery/open history)
-- Phase 1's "history" is simply the OS's own pending-notification queue,
-- read via LocalNotifications.getPending() — no server-side log needed
-- when nothing is server-scheduled.
