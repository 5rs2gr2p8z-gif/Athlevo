-- Athlevo — Founding Beta entitlement support.
-- Run MANUALLY in Supabase SQL Editor. Nothing here runs automatically.
--
-- Adds a founding_beta plan to the catalog so existing beta users
-- can receive 3 days of full access without creating fake Whop
-- subscriptions. The entitlement system treats founding_beta at
-- performance tier (2) and expires via current_period_end.

-- ─── 1. Add founding_beta to the plan catalog ─────────────────────

INSERT INTO public.subscription_plans
  (id, name, tier, description, monthly_price_cents, founder_price_cents, sort_order, is_active)
VALUES
  ('founding_beta', 'Founding Beta', 2,
   'Temporary full access for founding beta testers. Not a purchasable plan.',
   0, NULL, 99, false)
ON CONFLICT (id) DO NOTHING;

-- Note: is_active = false prevents this plan from appearing in any
-- future plan-picker UI. It exists only as a foreign-key target for
-- the subscriptions table.

-- The tier UNIQUE constraint on subscription_plans will conflict since
-- performance already occupies tier 2. Drop or alter if needed:
-- ALTER TABLE public.subscription_plans DROP CONSTRAINT IF EXISTS subscription_plans_tier_key;

-- ─── 2. Allow 'beta_granted' and 'beta_expired' event types ──────

-- Extend the event_type check constraint to include beta events.
ALTER TABLE public.subscription_events
  DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;

ALTER TABLE public.subscription_events
  ADD CONSTRAINT subscription_events_event_type_check
  CHECK (event_type IN (
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
    'founder_granted',
    'beta_granted',
    'beta_expired'
  ));
