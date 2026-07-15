-- Athlevo Score history (athlevo-score-v1).
-- Run this MANUALLY in Supabase BEFORE deploying the matching code.
-- Nothing here runs automatically. Additive and idempotent (safe to run
-- more than once).
--
-- Stores a daily snapshot of the athlete's Athlevo Score so the app can
-- show change over time and smooth the overall score against the previous
-- value. The score itself is DERIVED on demand by js/athlevoScore.js from
-- raw inputs (activities, execution records, confirmed races, and the
-- Current Running Level from the performance engine). This table only
-- persists the computed SNAPSHOT + provenance so history and smoothing are
-- reproducible — it is not an authoritative fitness source.
--
-- overall_score is NULL when the score is still "Building" (not enough
-- data). Component detail is kept in jsonb so the model can add or refine
-- components in a future version without a schema change.

create table if not exists public.athlevo_score_history (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  score_date date not null,

  -- 0–100, or NULL while the overall score is "Building".
  overall_score smallint
    check (overall_score is null or overall_score between 0 and 100),

  -- Per-component scores and statuses, e.g.
  --   component_scores  = {"aerobic":72,"threshold":null,...}
  --   component_statuses= {"aerobic":"valid","threshold":"Building",...}
  component_scores jsonb,
  component_statuses jsonb,

  -- "Strong data" | "Developing" | "Limited data"
  data_coverage text,

  model_version text not null,

  -- Signed change vs. the previous stored score, and plain-language why.
  change_from_previous smallint,
  change_reasons jsonb,

  -- Race/result/activity ids that fed this snapshot (provenance).
  source_ids jsonb,

  calculated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- One snapshot per athlete per day per model version (dedup).
  unique (user_id, score_date, model_version)
);

create index if not exists athlevo_score_history_user_idx
  on public.athlevo_score_history (user_id);

create index if not exists athlevo_score_history_user_date_idx
  on public.athlevo_score_history (user_id, score_date desc);

alter table public.athlevo_score_history enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlevo_score_history' and cmd='SELECT') then
    create policy "Athletes read own score history"
      on public.athlevo_score_history for select using (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlevo_score_history' and cmd='INSERT') then
    create policy "Athletes insert own score history"
      on public.athlevo_score_history for insert with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlevo_score_history' and cmd='UPDATE') then
    create policy "Athletes update own score history"
      on public.athlevo_score_history for update
      using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='athlevo_score_history' and cmd='DELETE') then
    create policy "Athletes delete own score history"
      on public.athlevo_score_history for delete using (auth.uid() = user_id);
  end if;
end $$;
