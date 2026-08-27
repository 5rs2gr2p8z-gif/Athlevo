-- Athlevo pre-signup diagnostic history.
-- Additive only: anonymous answers remain local until an authenticated import.

create table if not exists public.athlete_diagnostics (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  import_key          text not null check (char_length(import_key) between 16 and 120),
  schema_version      integer not null check (schema_version > 0),
  engine_version      text not null check (char_length(engine_version) between 1 and 80),
  started_at          timestamptz not null,
  completed_at        timestamptz not null,
  answers             jsonb not null check (jsonb_typeof(answers) = 'object'),
  result              jsonb not null check (jsonb_typeof(result) = 'object'),
  primary_limiter     text,
  feasibility         text,
  coaching_strategy   text,
  recommendation_reason text,
  acquisition_stage   text not null default 'awaiting_payment'
    check (acquisition_stage in (
      'awaiting_payment', 'checkout_started', 'payment_confirmed',
      'onboarding', 'completed', 'clearance_required'
    )),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint athlete_diagnostics_user_import_unique unique (user_id, import_key),
  constraint athlete_diagnostics_time_order check (completed_at >= started_at)
);

create index if not exists athlete_diagnostics_user_completed_idx
  on public.athlete_diagnostics (user_id, completed_at desc);

create index if not exists athlete_diagnostics_user_acquisition_idx
  on public.athlete_diagnostics (user_id, acquisition_stage, completed_at desc);

alter table public.athlete_diagnostics enable row level security;

revoke all on table public.athlete_diagnostics from public, anon;
grant select, insert, update on table public.athlete_diagnostics to authenticated;
grant select, insert, update on table public.athlete_diagnostics to service_role;

create policy "athletes can read own diagnostics"
  on public.athlete_diagnostics
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "athletes can insert own diagnostics"
  on public.athlete_diagnostics
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "athletes can update own diagnostics"
  on public.athlete_diagnostics
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

comment on table public.athlete_diagnostics is
  'Versioned diagnostic history imported after authentication; no anonymous access.';
