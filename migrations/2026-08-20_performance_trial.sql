-- Athlevo — 24-hour Performance Trial for free users.
-- Run MANUALLY in Supabase SQL Editor. Nothing here runs automatically.
--
-- Adds trial_started_at and free_plan_generated columns to subscriptions.
-- Creates an RPC that ensures every authenticated user gets a subscription
-- row with trial_started_at set (so the 24-hour clock is server-anchored).

-- ─── 1. Add trial columns ──────────────────────────────────────────

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS trial_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS free_plan_generated boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS subscriptions_trial_started_idx
  ON public.subscriptions (trial_started_at);

-- ─── 2. Backfill existing free users ───────────────────────────────
-- Existing free accounts (no paid provider) get trial_started_at = NOW()
-- so they receive a fresh 24-hour trial from deployment, not from their
-- original signup (which could be weeks ago and would expire immediately).
-- Paid users are unaffected — resolveEntitlement skips the trial check
-- when a recognised paid provider is active.

UPDATE public.subscriptions
SET trial_started_at = now(),
    updated_at = now()
WHERE trial_started_at IS NULL
  AND (provider IS NULL OR provider NOT IN ('whop', 'gcash_manual', 'paymongo')
       OR plan_id = 'free');

-- ─── 3. RPC: ensure a subscription row exists with trial ───────────
-- Called on every subscription load (client + server). Idempotent.
-- For users with no subscription row, creates a free row with
-- trial_started_at = now(). For users with a row but no trial_started_at,
-- sets it to now(). Returns the subscription row.

CREATE OR REPLACE FUNCTION public.ensure_free_trial(p_user_id uuid)
RETURNS SETOF public.subscriptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.subscriptions%ROWTYPE;
BEGIN
  -- Try to get existing row
  SELECT * INTO v_row
  FROM public.subscriptions
  WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    -- Create a new free subscription with trial
    INSERT INTO public.subscriptions (
      user_id, plan_id, status, billing_interval, trial_started_at
    ) VALUES (
      p_user_id, 'free', 'active', 'none', now()
    )
    ON CONFLICT (user_id) DO UPDATE
      SET trial_started_at = COALESCE(subscriptions.trial_started_at, now()),
          updated_at = now()
    RETURNING * INTO v_row;
  ELSIF v_row.trial_started_at IS NULL THEN
    -- Existing row without trial — give them a fresh trial
    UPDATE public.subscriptions
    SET trial_started_at = now(),
        updated_at = now()
    WHERE user_id = p_user_id
    RETURNING * INTO v_row;
  END IF;

  RETURN NEXT v_row;
END;
$$;

-- Allow authenticated users to call this for themselves only.
-- The function is SECURITY DEFINER so it can INSERT/UPDATE subscriptions
-- (which users normally cannot write to). The p_user_id parameter is
-- validated by the caller to match auth.uid().
REVOKE ALL ON FUNCTION public.ensure_free_trial(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_free_trial(uuid) TO authenticated, service_role;

-- ─── 4. Allow 'trial_expired' event type ────────────────────────────

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
    'beta_expired',
    'trial_expired'
  ));
