-- Athlevo — pace_feedback (aerobic pace calibration feedback loop).
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
-- Additive, idempotent, RLS-scoped. Preserves all existing data.
--
-- Stores the lightweight "Did this pace feel appropriate?" responses used
-- to gently, gradually bias the athlete's aerobic (Recovery/Easy) pace
-- calibration. One response never rewrites the model — the engine only
-- aggregates recent responses into a small, capped seconds/km bias.

create table if not exists public.pace_feedback (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  -- The activity the feedback is about (nullable for a general response).
  activity_id text,

  -- Which aerobic category the feedback relates to.
  category text not null default 'easy'
    check (category in ('recovery', 'easy', 'long')),

  -- The athlete's answer.
  rating text not null
    check (rating in ('too_easy', 'about_right', 'too_hard')),

  created_at timestamptz not null default now()
);

create index if not exists pace_feedback_user_idx
  on public.pace_feedback (user_id, created_at desc);

-- One feedback per athlete per activity (a repeat updates, never duplicates).
create unique index if not exists pace_feedback_user_activity_uidx
  on public.pace_feedback (user_id, activity_id)
  where activity_id is not null;

alter table public.pace_feedback enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='pace_feedback' and cmd='SELECT') then
    create policy "Athletes read own pace feedback"
      on public.pace_feedback for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='pace_feedback' and cmd='INSERT') then
    create policy "Athletes insert own pace feedback"
      on public.pace_feedback for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='pace_feedback' and cmd='UPDATE') then
    create policy "Athletes update own pace feedback"
      on public.pace_feedback for update
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;
