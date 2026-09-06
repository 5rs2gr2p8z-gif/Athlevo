-- Athlevo — persistent Coach conversation threads.
-- Adds a coach_threads table and a thread_id column to coach_conversations.
-- Apply manually after review. Idempotent where practical.

-- ══════════════ 1. Create coach_threads ══════════════════════════════

create table if not exists public.coach_threads (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  title           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),

  -- Composite unique so foreign keys can enforce same-user ownership.
  constraint coach_threads_user_unique unique (id, user_id)
);

create index if not exists coach_threads_user_last_msg_idx
  on public.coach_threads (user_id, last_message_at desc);

-- ══════════════ 2. Add thread_id to coach_conversations ═════════════

-- Add the column nullable first (safe for existing rows).
alter table public.coach_conversations
  add column if not exists thread_id uuid;

-- Composite foreign key: guarantees a message's thread belongs to the
-- same user_id as the message itself.  Database-level ownership guard.
do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'coach_conversations_thread_ownership'
      and table_name = 'coach_conversations'
  ) then
    alter table public.coach_conversations
      add constraint coach_conversations_thread_ownership
      foreign key (thread_id, user_id)
      references public.coach_threads (id, user_id)
      on delete cascade;
  end if;
end $$;

create index if not exists coach_conversations_thread_created_idx
  on public.coach_conversations (thread_id, created_at asc);

-- ══════════════ 3. RLS on coach_threads ═════════════════════════════

alter table public.coach_threads enable row level security;

-- SELECT own rows only.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'coach_threads' and policyname = 'coach_threads_select_own'
  ) then
    create policy coach_threads_select_own on public.coach_threads
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- INSERT own rows only.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'coach_threads' and policyname = 'coach_threads_insert_own'
  ) then
    create policy coach_threads_insert_own on public.coach_threads
      for insert with check (auth.uid() = user_id);
  end if;
end $$;

-- UPDATE own rows only.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'coach_threads' and policyname = 'coach_threads_update_own'
  ) then
    create policy coach_threads_update_own on public.coach_threads
      for update using (auth.uid() = user_id);
  end if;
end $$;

-- DELETE own rows only (for account cleanup).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'coach_threads' and policyname = 'coach_threads_delete_own'
  ) then
    create policy coach_threads_delete_own on public.coach_threads
      for delete using (auth.uid() = user_id);
  end if;
end $$;

-- ══════════════ 4. Backfill — one initial thread per existing user ══

-- For every user who has messages, create a single thread titled from
-- their first meaningful user message, then assign all their messages.
-- Deterministic: uses the user's earliest message timestamp as
-- created_at and the latest as last_message_at.

do $$
declare
  r record;
  new_thread_id uuid;
  thread_title text;
begin
  for r in
    select
      cc.user_id,
      min(cc.created_at) as first_at,
      max(cc.created_at) as last_at
    from public.coach_conversations cc
    where cc.thread_id is null
    group by cc.user_id
  loop
    -- Derive title from first meaningful user message.
    select substring(cc.message from 1 for 60)
    into thread_title
    from public.coach_conversations cc
    where cc.user_id = r.user_id
      and cc.role = 'user'
      and char_length(btrim(cc.message)) > 3
    order by cc.created_at asc
    limit 1;

    if thread_title is null or btrim(thread_title) = '' then
      thread_title := 'Previous conversation';
    end if;

    new_thread_id := gen_random_uuid();

    insert into public.coach_threads (id, user_id, title, created_at, updated_at, last_message_at)
    values (new_thread_id, r.user_id, thread_title, r.first_at, r.last_at, r.last_at);

    update public.coach_conversations
    set thread_id = new_thread_id
    where user_id = r.user_id
      and thread_id is null;
  end loop;
end $$;

-- ══════════════ 5. Make thread_id NOT NULL for future messages ═══════
-- Only safe after all existing rows have been backfilled above.

alter table public.coach_conversations
  alter column thread_id set not null;
