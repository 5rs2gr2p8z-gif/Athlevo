-- Athlevo Athlete Memory upgrade.
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
--
-- The athlete_memory and coach_conversations tables already exist and are
-- in active use. This migration is ADDITIVE and idempotent:
--   * adds durable-fact lifecycle columns to athlete_memory
--     (first_observed_at, confidence [internal], verification_state,
--     superseded_by / superseded_at)
--   * backfills first_observed_at from existing timestamps
--   * ensures helpful indexes
--   * ensures Row Level Security + user-owned policies on both tables so
--     one athlete can never read another's conversations or memories
--
-- It does NOT drop or rename anything and is safe to run once.

-- ─── 1. athlete_memory: durable-fact lifecycle columns ──────────

alter table public.athlete_memory
  add column if not exists first_observed_at timestamptz,
  add column if not exists last_confirmed_at timestamptz,
  add column if not exists confidence smallint,               -- internal only, 0–100
  add column if not exists verification_state text not null default 'verified',
  add column if not exists superseded_by uuid,
  add column if not exists superseded_at timestamptz;

-- verification_state may only be verified | unverified.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'athlete_memory_verification_state_check'
  ) then
    alter table public.athlete_memory
      add constraint athlete_memory_verification_state_check
      check (verification_state in ('verified', 'unverified'));
  end if;
end $$;

-- confidence range guard (internal use only, never shown to athletes).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'athlete_memory_confidence_check'
  ) then
    alter table public.athlete_memory
      add constraint athlete_memory_confidence_check
      check (confidence is null or confidence between 0 and 100);
  end if;
end $$;

-- Backfill first_observed_at for existing rows from their original
-- timestamps, THEN default it for future inserts (so new memories get a
-- timestamp automatically while existing rows keep their true origin).
update public.athlete_memory
set first_observed_at = coalesce(first_observed_at, created_at, updated_at, now())
where first_observed_at is null;

alter table public.athlete_memory
  alter column first_observed_at set default now();

create index if not exists athlete_memory_user_idx
  on public.athlete_memory (user_id);
create index if not exists athlete_memory_user_active_idx
  on public.athlete_memory (user_id, is_active);
create index if not exists athlete_memory_user_category_idx
  on public.athlete_memory (user_id, category);

-- ─── 2. RLS: athlete_memory (idempotent, user-owned) ───────────

alter table public.athlete_memory enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlete_memory' and cmd='SELECT') then
    create policy "Athletes read own memory"
      on public.athlete_memory for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlete_memory' and cmd='INSERT') then
    create policy "Athletes insert own memory"
      on public.athlete_memory for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlete_memory' and cmd='UPDATE') then
    create policy "Athletes update own memory"
      on public.athlete_memory for update using (auth.uid() = user_id)
      with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlete_memory' and cmd='DELETE') then
    create policy "Athletes delete own memory"
      on public.athlete_memory for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ─── 3. RLS + index: coach_conversations (idempotent) ──────────

create index if not exists coach_conversations_user_created_idx
  on public.coach_conversations (user_id, created_at desc);

alter table public.coach_conversations enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='coach_conversations' and cmd='SELECT') then
    create policy "Athletes read own conversations"
      on public.coach_conversations for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='coach_conversations' and cmd='INSERT') then
    create policy "Athletes insert own conversations"
      on public.coach_conversations for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='coach_conversations' and cmd='DELETE') then
    create policy "Athletes delete own conversations"
      on public.coach_conversations for delete using (auth.uid() = user_id);
  end if;
end $$;

-- The server (service role) bypasses RLS to run memory extraction and to
-- build coaching context. Account deletion cascades from auth.users where
-- these tables reference it; verify the FK/cleanup matches your existing
-- deletion design before relying on it.
