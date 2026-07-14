-- Athlevo subscription architecture (NO payment logic).
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
--
-- Design goals:
--   * Provider-agnostic. All PayMongo/Stripe-specific fields are nullable
--     `provider_*` columns on subscriptions; entitlement logic never
--     reads them, so swapping providers later touches only billing code.
--   * The feature→plan mapping lives in code (lib/server/features.js and
--     js/features.js) — the single central registry. These tables hold
--     the plan CATALOG and each athlete's subscription STATE, not the
--     feature rules.
--   * Supports free trial, monthly, annual, renewals, grace, past-due,
--     cancellation, expiry, and founder pricing — as data, not code.

-- ─── 1. Plan catalog ────────────────────────────────────────────

create table if not exists public.subscription_plans (
  id text primary key,               -- slug: free | essentials | performance | elite
  name text not null,
  tier smallint not null,            -- rank used for entitlement (free=0 … elite=3)
  description text,

  -- Display/pricing only (provider-agnostic, minor units e.g. centavos).
  currency text not null default 'PHP',
  monthly_price_cents integer,
  annual_price_cents integer,        -- future annual plans
  founder_price_cents integer,       -- founder pricing

  is_active boolean not null default true,
  sort_order smallint not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (tier)
);

alter table public.subscription_plans enable row level security;

-- The catalog is readable by any authenticated athlete; only the service
-- role manages it.
create policy "Anyone authenticated reads plans"
  on public.subscription_plans for select
  using (auth.role() = 'authenticated');

insert into public.subscription_plans
  (id, name, tier, description, monthly_price_cents, founder_price_cents, sort_order)
values
  ('free',        'Free',        0, 'Core training tools to get started.',                 0,    null, 0),
  ('essentials',  'Essentials',  1, 'Everyday AI coaching and adaptive guidance.',          null, null, 1),
  ('performance', 'Performance', 2, 'Full adaptive coaching, modifications, and analysis.', null, null, 2),
  ('elite',       'Elite',       3, 'Everything, plus advanced analytics and reports.',     null, null, 3)
on conflict (id) do nothing;

-- ─── 2. Subscription state (one current row per athlete) ────────

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null unique
    references auth.users (id) on delete cascade,

  plan_id text not null default 'free'
    references public.subscription_plans (id),

  -- Lifecycle. A missing row (or 'free') means the Free plan.
  status text not null default 'active'
    check (status in (
      'trialing',
      'active',
      'past_due',
      'grace',
      'cancelled',
      'expired'
    )),

  billing_interval text not null default 'none'
    check (billing_interval in ('none', 'monthly', 'annual')),

  is_founder boolean not null default false,

  trial_end timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,

  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  started_at timestamptz not null default now(),

  -- Provider-agnostic billing linkage. All nullable — no provider is
  -- integrated yet. Feature logic never reads these.
  provider text,                     -- 'paymongo' | 'stripe' | 'manual' | null
  provider_customer_id text,
  provider_subscription_id text,
  provider_price_id text,

  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_idx
  on public.subscriptions (user_id);
create index if not exists subscriptions_status_idx
  on public.subscriptions (status);
create index if not exists subscriptions_period_end_idx
  on public.subscriptions (current_period_end);

alter table public.subscriptions enable row level security;

-- Athletes may READ their own subscription. Writes are done by the
-- service role (future billing), so there is no user insert/update policy
-- — a user can never grant themselves a paid plan.
create policy "Athletes read own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- ─── 3. Subscription events (audit / future webhook ledger) ─────

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null
    references auth.users (id) on delete cascade,

  subscription_id uuid
    references public.subscriptions (id) on delete set null,

  event_type text not null
    check (event_type in (
      'created',
      'trial_started',
      'activated',
      'renewed',
      'payment_failed',
      'entered_grace',
      'past_due',
      'cancelled',
      'expired',
      'reactivated',
      'plan_changed',
      'founder_granted'
    )),

  from_plan text,
  to_plan text,
  from_status text,
  to_status text,

  provider text,
  provider_event_id text,            -- for future webhook idempotency

  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- One row per provider event (idempotent webhook processing later).
  unique (provider, provider_event_id)
);

create index if not exists subscription_events_user_idx
  on public.subscription_events (user_id, occurred_at desc);

alter table public.subscription_events enable row level security;

create policy "Athletes read own subscription events"
  on public.subscription_events for select
  using (auth.uid() = user_id);

-- The service role bypasses RLS to create subscriptions/events and to
-- transition lifecycle states (trial end, renewal, grace, expiry).
