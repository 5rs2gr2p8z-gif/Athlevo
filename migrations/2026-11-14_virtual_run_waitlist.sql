-- Athlevo Sub-1 10k Challenge: the priority list (people who want to hear first when registration opens).
-- Run once in the Supabase SQL editor. Safe to run again (it only creates what is missing).
--
-- What it holds: a name and an email, the version and time of the consent they gave, an optional short
-- campaign label, and a secret token that lets each e-mail carry a one-click "leave the list" link.
-- It holds no IP address, no browser details and no payment information.

create table if not exists public.virtual_run_waitlist (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  full_name text not null,
  email text not null,                       -- always stored lower-case
  consent_version text not null,             -- WAITLIST.consentVersion in content/virtualRun.mjs when they agreed
  consented_at timestamptz not null,
  source text,                               -- short campaign label from the link they came from, if any
  unsubscribe_token text not null,           -- secret; goes only in that person's own e-mails
  status text not null default 'active' check (status in ('active', 'unsubscribed')),
  unsubscribed_at timestamptz,
  confirmation_email_status text,            -- sent / failed / null (not tried)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per person per event, however many times they press the button.
create unique index if not exists virtual_run_waitlist_event_email_key
  on public.virtual_run_waitlist (event, email);
create unique index if not exists virtual_run_waitlist_token_key
  on public.virtual_run_waitlist (unsubscribe_token);
create index if not exists virtual_run_waitlist_event_created_idx
  on public.virtual_run_waitlist (event, created_at desc);

-- Only the server (service role key) and the protected staff page can read or write this.
-- Row level security is on and there are deliberately no policies, so the public (anon) key sees nothing.
alter table public.virtual_run_waitlist enable row level security;

-- Optional, run by hand when the event is over (the list is kept only as long as it is needed):
-- delete from public.virtual_run_waitlist where event = 'athlevo-sub-1-10k-2026';
