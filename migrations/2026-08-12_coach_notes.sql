-- Athlevo — private coach notes for one assigned athlete.
-- Apply manually after review. This migration is additive and does not alter
-- athlete-facing readiness, profiles, plans, messaging, or provider data.

create table if not exists public.coach_notes (
  id             uuid primary key default gen_random_uuid(),
  athlete_id     uuid not null references auth.users (id) on delete cascade,
  author_user_id uuid not null references auth.users (id) on delete cascade,
  body           text not null check (char_length(btrim(body)) between 1 and 4000),
  pinned         boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists coach_notes_athlete_order_idx
  on public.coach_notes (athlete_id, pinned desc, created_at desc);

create index if not exists coach_notes_author_idx
  on public.coach_notes (author_user_id, created_at desc);

alter table public.coach_notes enable row level security;

-- Intentionally no authenticated policies. RLS therefore default-denies every
-- browser read and write, including the athlete. All access goes through the
-- service-role server gateway after role, active assignment, permission, and
-- author ownership are re-verified.
