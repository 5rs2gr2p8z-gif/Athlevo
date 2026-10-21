-- Partner discount codes for the public /programs sign-up (Athlevo Plan and Athlevo Coaching).
-- Additive and safe to re-run. Run manually in Supabase (SQL editor) BEFORE giving anyone a code.
--
-- One row per code, and a code belongs to one runner. The server (lib/server/partnerCodes.js)
-- reads this table with the service role to price a checkout; the browser never reads it.
-- `partner` is an internal label (for example 'race-2026-11-24') and is never shown to buyers.
-- There is intentionally no policy on either table, so anon and authenticated users can neither
-- read nor change them.

create table if not exists public.partner_codes (
  code text primary key check (code ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$'),
  partner text not null,
  percent_off integer not null default 10 check (percent_off between 1 and 50),
  product_ids text[],
  active boolean not null default true,
  expires_at timestamptz,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists partner_codes_partner_idx on public.partner_codes (partner);

alter table public.partner_codes enable row level security;

-- Each paid sign-up made with a code records it, so a partner's share can be worked out later.
alter table public.plan_signups add column if not exists partner_code text;
alter table public.plan_signups add column if not exists partner text;
alter table public.plan_signups add column if not exists list_price_cents integer;
alter table public.plan_signups add column if not exists discount_percent integer;

create index if not exists plan_signups_partner_idx
  on public.plan_signups (partner, paid_at)
  where partner_code is not null;
create index if not exists plan_signups_partner_code_idx
  on public.plan_signups (partner_code, paid_at)
  where partner_code is not null;
