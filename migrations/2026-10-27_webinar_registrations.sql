-- Free webinar registrations from the public /webinar page (Ignite the Grit Run session).
-- Additive and safe to re-run. Run manually in Supabase (SQL editor).
--
-- One row per registration. Rows are written only by the server (POST /api/webinar/register)
-- using the service role; there is intentionally no INSERT/UPDATE/DELETE/SELECT policy, so the
-- browser (anon or authenticated) can neither read nor change them. Read them in the Supabase
-- table editor. `status` and `notes` are yours to use for follow-up ("contacted", "attended"...).
--
-- The form's choices are not enforced here, so adding one later (say a 21k option) never makes a
-- registration fail. The server checks them before saving.

create table if not exists public.webinar_registrations (
  id uuid primary key default gen_random_uuid(),
  event text not null default 'ignite-the-grit-2026',
  name text not null,
  mobile text not null,
  email text,
  distance text not null,
  training text not null,
  question text,
  status text not null default 'new',
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists webinar_registrations_created_idx
  on public.webinar_registrations (created_at desc);
create index if not exists webinar_registrations_event_mobile_idx
  on public.webinar_registrations (event, mobile);

alter table public.webinar_registrations enable row level security;
