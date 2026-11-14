-- Athlevo Sub-1 10k Challenge registrations (the /virtual-run page).
-- Additive and safe to re-run. Run manually in Supabase (SQL editor) BEFORE opening registration
-- (VIRTUAL_RUN_SIGNUP_ENABLED=true in Vercel).
--
-- One row per registration attempt. The server (service role) writes a row as "pending" when a runner
-- starts payment, and the signature-verified PayMongo webhook turns it into "paid". Nothing else can.
-- There is intentionally no SELECT/INSERT/UPDATE/DELETE policy, so the browser (anon or authenticated)
-- can neither read nor change any row. Staff read registrations through /virtual-run/admin, which the
-- server checks against the staff list on every request, or in the Supabase table editor.
--
-- This table holds personal details (name, email, mobile, date of birth, delivery address). Keep it
-- that way: no public view, no anon grants. See the clean-up statement at the bottom.

create table if not exists public.virtual_run_registrations (
  id uuid primary key default gen_random_uuid(),

  -- The short ID the runner sees (SUB1-XXXXXXXX) and the long secret reference PayMongo carries.
  registration_id text not null unique,
  reference_number text not null unique,
  event text not null,

  -- What was bought. amount_cents is set by the server from the package config, never by the browser.
  package_id text not null,
  package_name text not null,
  product_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'PHP',

  -- Payment. 'pending' until the webhook confirms the payment.
  payment_status text not null default 'pending'
    check (payment_status in ('pending', 'paid', 'failed', 'expired', 'cancelled', 'refunded')),
  hold_expires_at timestamptz,
  provider text not null default 'paymongo',
  provider_checkout_id text,
  provider_payment_id text unique,
  payment_method_type text,
  livemode boolean not null default false,
  paid_at timestamptz,
  refunded_at timestamptz,

  -- Participant
  full_name text not null,
  email text not null,
  mobile text not null,
  date_of_birth date not null,
  gender text,

  -- Running information
  pb_5k text,
  pb_10k text,
  weekly_frequency text not null,
  primary_goal text not null,

  -- Delivery (physical packages only; all null for the Digital Challenge)
  shirt_size text,
  recipient_name text,
  address_line text,
  province text,
  city text,
  barangay text,
  postal_code text,

  -- What the runner agreed to, and which wording (LEGAL.version in content/virtualRun.mjs)
  rules_accepted_at timestamptz not null,
  privacy_accepted_at timestamptz not null,
  legal_version text not null,

  -- Confirmation email
  confirmation_email_status text,
  confirmation_sent_at timestamptz,

  -- Result submission (the registration page does not collect results; this is where they will be tracked)
  result_status text not null default 'not_submitted'
    check (result_status in ('not_submitted', 'submitted', 'verified', 'not_verified')),

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists virtual_run_registrations_event_status_idx
  on public.virtual_run_registrations (event, payment_status);
create index if not exists virtual_run_registrations_package_idx
  on public.virtual_run_registrations (event, package_id, payment_status);
create index if not exists virtual_run_registrations_email_idx
  on public.virtual_run_registrations (event, lower(email));
create index if not exists virtual_run_registrations_created_idx
  on public.virtual_run_registrations (created_at desc);

alter table public.virtual_run_registrations enable row level security;

-- Housekeeping (run by hand when you want to; it is NOT scheduled). Unpaid attempts keep a runner's
-- details for no reason once the checkout is long abandoned. This removes them after 30 days:
--
--   delete from public.virtual_run_registrations
--   where payment_status in ('pending', 'failed', 'expired', 'cancelled')
--     and created_at < now() - interval '30 days';
