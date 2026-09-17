-- Athlevo — AI-processing consent (App Store P0 blocker).
-- Run this MANUALLY in Supabase BEFORE deploying the matching server/client
-- code. Nothing here runs automatically. Idempotent (create if not exists).
--
-- Scope: one small, purpose-scoped, RLS-owned table per feature area,
-- matching the existing convention (see notification_preferences,
-- coach_notes). Deliberately NOT added as columns on the already-large
-- `profiles` table.
--
-- Semantics: the ABSENCE of a row for a user means "no consent recorded" —
-- existing users are never auto-granted. status is only ever written by an
-- explicit user action (Continue / Turn off / Enable in Settings).

create table if not exists public.ai_consent (
  user_id uuid primary key
    references auth.users (id) on delete cascade,

  -- granted | denied | withdrawn. "denied" = explicit "Not now" from the
  -- consent prompt (session-visible only until they act again); "withdrawn"
  -- = they had granted, then turned it off in Settings. Both block AI
  -- processing identically — the distinction is kept only so Settings and
  -- analytics can tell "never opted in" apart from "opted in, then out".
  status text not null
    check (status in ('granted', 'denied', 'withdrawn')),

  -- Version of the disclosure copy the athlete actually saw when they last
  -- changed status. Lets Athlevo re-prompt only when the disclosure
  -- materially changes, without a full policy-version engine.
  consent_version text not null default '1',

  granted_at timestamptz,
  withdrawn_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ai_consent_status_idx
  on public.ai_consent (status);

alter table public.ai_consent enable row level security;

drop policy if exists "Athletes read own AI consent" on public.ai_consent;
create policy "Athletes read own AI consent"
  on public.ai_consent for select
  using (auth.uid() = user_id);

drop policy if exists "Athletes insert own AI consent" on public.ai_consent;
create policy "Athletes insert own AI consent"
  on public.ai_consent for insert
  with check (auth.uid() = user_id);

drop policy if exists "Athletes update own AI consent" on public.ai_consent;
create policy "Athletes update own AI consent"
  on public.ai_consent for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No delete policy: rows are removed only by the auth.users cascade on
-- account deletion (see section 15 of the consent task) — an athlete
-- withdraws by updating status, never by deleting the row.

-- Server-side gating (lib/server/aiConsent.js) always reads this table with
-- the service-role key, never trusting a client-supplied boolean. RLS above
-- governs the athlete's OWN direct read/write of their own row (Settings
-- toggle), matching the notification_preferences pattern.
