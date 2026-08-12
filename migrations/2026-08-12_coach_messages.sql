-- Athlevo — assignment-scoped human coach messaging.
-- Apply manually after review. This does not alter athlete AI Coach history.

create table if not exists public.coach_messages (
  id             uuid primary key default gen_random_uuid(),
  coach_id       uuid not null references auth.users (id) on delete cascade,
  athlete_id     uuid not null references auth.users (id) on delete cascade,
  sender_user_id uuid not null references auth.users (id) on delete cascade,
  sender_role    text not null check (sender_role in ('coach', 'athlete')),
  body           text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at     timestamptz not null default now(),
  constraint coach_messages_distinct_participants check (coach_id <> athlete_id),
  constraint coach_messages_sender_matches_role
    check (
      (sender_role = 'coach' and sender_user_id = coach_id) or
      (sender_role = 'athlete' and sender_user_id = athlete_id)
    )
);

create index if not exists coach_messages_thread_created_idx
  on public.coach_messages (coach_id, athlete_id, created_at asc);

alter table public.coach_messages enable row level security;

-- No authenticated policies are created. Browser reads and writes, including
-- direct athlete/coach Supabase calls, default-deny. The service-role gateway
-- re-verifies JWT, coach/admin role, ACTIVE assignment, athlete scope, and
-- derives sender identity before every read or send.
