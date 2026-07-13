-- Athlevo private beta feedback & suggestions.
-- Run this MANUALLY in Supabase BEFORE relying on the You-screen
-- "Feedback & Suggestions" form. Nothing here runs automatically.
--
-- Design notes:
--   * Each row is owned by the athlete who created it. RLS lets an
--     athlete insert and read ONLY their own submissions — no athlete
--     can see another athlete's feedback, and internal triage fields
--     (status, and any future admin notes) are never widened to other
--     users because SELECT is scoped to auth.uid() = user_id.
--   * Submissions are private: there is no public/select-all policy.

create table if not exists public.beta_feedback (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  category text not null
    check (category in (
      'bug',
      'coaching',
      'feature',
      'confusing',
      'other'
    )),

  subject text
    check (subject is null or char_length(subject) <= 200),

  message text not null
    check (char_length(message) between 1 and 8000),

  affected_screen text
    check (affected_screen is null or char_length(affected_screen) <= 80),

  allow_follow_up boolean not null default true,

  app_version text
    check (app_version is null or char_length(app_version) <= 80),

  -- Internal triage state. Athletes may read their own row but the UI
  -- never exposes this; it exists for the team's workflow.
  status text not null default 'new'
    check (status in ('new', 'triaged', 'in_progress', 'resolved', 'wont_fix')),

  created_at timestamptz not null default now()
);

-- ─── indexes ────────────────────────────────────────────────────

create index if not exists beta_feedback_user_idx
  on public.beta_feedback (user_id);

create index if not exists beta_feedback_user_created_idx
  on public.beta_feedback (user_id, created_at desc);

create index if not exists beta_feedback_status_idx
  on public.beta_feedback (status);

-- ─── row level security (user-owned) ────────────────────────────

alter table public.beta_feedback enable row level security;

create policy "Athletes insert own feedback"
  on public.beta_feedback for insert
  with check (auth.uid() = user_id);

create policy "Athletes read own feedback"
  on public.beta_feedback for select
  using (auth.uid() = user_id);

-- Intentionally NO update/delete policy for athletes: a submission is a
-- record. The team reads and triages via the service role, which
-- bypasses RLS. No policy exposes other athletes' rows.
