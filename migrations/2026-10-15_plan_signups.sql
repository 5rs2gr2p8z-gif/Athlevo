-- Athlevo Plan sign-ups from the public /store page.
-- Additive and safe to re-run. Run manually in Supabase (SQL editor) BEFORE
-- setting PLAN_SIGNUP_ENABLED=true in Vercel.
--
-- One row per verified paid PayMongo checkout. Rows are written only by the
-- signature-verified webhook using the service role; there is intentionally no
-- INSERT/UPDATE/DELETE/SELECT policy, so the browser (anon or authenticated)
-- can neither read nor change them. Test-mode payments are stored with
-- livemode = false so they are easy to filter out.

create table if not exists public.plan_signups (
  id uuid primary key default gen_random_uuid(),
  reference_number text not null unique,
  provider text not null default 'paymongo' check (provider in ('paymongo')),
  provider_checkout_id text not null,
  provider_payment_id text not null unique,
  status text not null default 'paid' check (status in ('paid', 'refunded')),
  product_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'PHP',
  entitlement_days integer not null check (entitlement_days > 0),
  payment_method_type text,
  customer_name text,
  customer_email text,
  customer_phone text,
  livemode boolean not null default false,
  paid_at timestamptz not null default now(),
  paid_through timestamptz not null,
  refunded_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists plan_signups_paid_at_idx
  on public.plan_signups (paid_at desc);
create index if not exists plan_signups_email_idx
  on public.plan_signups (lower(customer_email));
create index if not exists plan_signups_paid_through_idx
  on public.plan_signups (paid_through);

alter table public.plan_signups enable row level security;
