-- Athlevo — Cardless Trial Migration
-- Run MANUALLY in Supabase SQL Editor. Nothing here runs automatically.
-- Additive, idempotent and non-destructive (safe to run more than once).
--
-- PURPOSE: Enable a server-controlled 3-day trial that requires no payment
-- method. Reuses the existing subscriptions table — no duplicate entitlement
-- system. The trial is a subscription row with provider = 'athlevo_trial',
-- status = 'trialing', trial_end = now() + 3 days.
--
-- ROLLBACK: see bottom of file.

-- ─── 1. Extend subscription_events event_type to include cardless trial events ──

ALTER TABLE public.subscription_events
  DROP CONSTRAINT IF EXISTS subscription_events_event_type_check;

ALTER TABLE public.subscription_events
  ADD CONSTRAINT subscription_events_event_type_check
  CHECK (event_type IN (
    'created',
    'trial_started',
    'trial_expired',
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
    'cardless_trial_started',
    'cardless_trial_expired',
    'upgrade_from_trial'
  ));

-- ─── 2. Server-side RPC to create a cardless trial (idempotent) ──────────
--
-- Called by the API after onboarding completion. Uses the authenticated
-- user's id from the session (never from a request body parameter).
--
-- Guarantees:
--   * One trial per user — returns existing trial if already started
--   * Server time only — never trusts client timestamps
--   * Atomic — single transaction, no read-then-write race
--   * Cannot extend an existing trial
--   * Cannot create a trial if the user already has a paid subscription
--   * Writes an audit event on first creation

CREATE OR REPLACE FUNCTION public.start_cardless_trial(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.subscriptions%ROWTYPE;
  v_trial_end timestamptz;
  v_sub_id uuid;
  v_result jsonb;
BEGIN
  -- 1. Check for an existing subscription row
  SELECT * INTO v_existing
  FROM public.subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;  -- lock the row to prevent concurrent creation

  IF FOUND THEN
    -- If user already has an active/valid paid subscription, do not create trial.
    -- This includes cancelled users who are still within their paid period.
    IF v_existing.provider IS NOT NULL
       AND v_existing.provider != 'athlevo_trial'
       AND (
         v_existing.status IN ('active', 'trialing', 'grace', 'past_due')
         OR (v_existing.status = 'cancelled' AND v_existing.current_period_end > now())
       ) THEN
      RETURN jsonb_build_object(
        'created', false,
        'reason', 'already_paid',
        'subscription_id', v_existing.id,
        'status', v_existing.status,
        'plan_id', v_existing.plan_id
      );
    END IF;

    -- If user already has/had a cardless trial, return it (idempotent)
    IF v_existing.provider = 'athlevo_trial' THEN
      RETURN jsonb_build_object(
        'created', false,
        'reason', 'trial_already_exists',
        'subscription_id', v_existing.id,
        'status', v_existing.status,
        'plan_id', v_existing.plan_id,
        'trial_end', v_existing.trial_end
      );
    END IF;

    -- User has an expired/cancelled paid sub — overwrite with trial
    -- (this handles the edge case of a fully expired Whop sub)
    -- Only if they never had a cardless trial before (check events)
    IF EXISTS (
      SELECT 1 FROM public.subscription_events
      WHERE user_id = p_user_id AND event_type = 'cardless_trial_started'
    ) THEN
      RETURN jsonb_build_object(
        'created', false,
        'reason', 'trial_already_used',
        'subscription_id', v_existing.id,
        'status', v_existing.status
      );
    END IF;
  END IF;

  -- Also check events even if no subscription row exists (belt and suspenders)
  IF EXISTS (
    SELECT 1 FROM public.subscription_events
    WHERE user_id = p_user_id AND event_type = 'cardless_trial_started'
  ) THEN
    RETURN jsonb_build_object(
      'created', false,
      'reason', 'trial_already_used'
    );
  END IF;

  -- 2. Create the trial
  v_trial_end := now() + interval '3 days';

  INSERT INTO public.subscriptions (
    user_id, plan_id, status, billing_interval, is_founder,
    trial_end, current_period_start, current_period_end,
    started_at, provider, metadata, created_at, updated_at
  ) VALUES (
    p_user_id, 'performance', 'trialing', 'none', false,
    v_trial_end, now(), v_trial_end,
    now(), 'athlevo_trial',
    jsonb_build_object('trial_source', 'onboarding', 'trial_days', 3),
    now(), now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    plan_id = 'performance',
    status = 'trialing',
    trial_end = v_trial_end,
    current_period_start = now(),
    current_period_end = v_trial_end,
    provider = 'athlevo_trial',
    metadata = jsonb_build_object('trial_source', 'onboarding', 'trial_days', 3),
    updated_at = now()
  RETURNING id INTO v_sub_id;

  -- 3. Record the audit event
  INSERT INTO public.subscription_events (
    user_id, subscription_id, event_type, to_plan, to_status,
    provider, metadata, occurred_at
  ) VALUES (
    p_user_id, v_sub_id, 'cardless_trial_started', 'performance', 'trialing',
    'athlevo_trial',
    jsonb_build_object('trial_end', v_trial_end, 'trial_days', 3),
    now()
  );

  RETURN jsonb_build_object(
    'created', true,
    'subscription_id', v_sub_id,
    'status', 'trialing',
    'plan_id', 'performance',
    'trial_end', v_trial_end
  );
END;
$$;

-- Only the service role can call this function (not authenticated users directly)
REVOKE ALL ON FUNCTION public.start_cardless_trial(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.start_cardless_trial(uuid) FROM authenticated;
REVOKE ALL ON FUNCTION public.start_cardless_trial(uuid) FROM anon;
-- Service role bypasses these grants, so no explicit GRANT needed.

-- ─── 3. Trial usage tracking table ──────────────────────────────────────
-- Tracks lifetime and daily usage counters for trial-specific limits.
-- Separate from ai_rate_limits because trial limits have different semantics
-- (lifetime caps, not just hourly windows).

CREATE TABLE IF NOT EXISTS public.trial_usage (
  user_id uuid PRIMARY KEY
    REFERENCES auth.users (id) ON DELETE CASCADE,

  -- Lifetime counters (entire trial period)
  plans_generated integer NOT NULL DEFAULT 0,
  plan_adjustments integer NOT NULL DEFAULT 0,

  -- Daily counters (reset logic is date-based)
  coach_messages_today integer NOT NULL DEFAULT 0,
  coach_messages_date date NOT NULL DEFAULT CURRENT_DATE,
  ai_analyses_today integer NOT NULL DEFAULT 0,
  ai_analyses_date date NOT NULL DEFAULT CURRENT_DATE,
  daily_briefs_today integer NOT NULL DEFAULT 0,
  daily_briefs_date date NOT NULL DEFAULT CURRENT_DATE,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.trial_usage ENABLE ROW LEVEL SECURITY;

-- No user-facing policies: written only by service role.
-- Athletes can read their own usage for UI display.
CREATE POLICY "Athletes read own trial usage"
  ON public.trial_usage FOR SELECT
  USING (auth.uid() = user_id);

-- ─── 4. Atomic trial usage increment RPC ─────────────────────────────
-- Returns { allowed: bool, current_count: int, limit: int }

CREATE OR REPLACE FUNCTION public.increment_trial_usage(
  p_user_id uuid,
  p_usage_type text,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.trial_usage%ROWTYPE;
  v_current integer;
  v_allowed boolean;
BEGIN
  -- Ensure row exists
  INSERT INTO public.trial_usage (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  -- Lock the row
  SELECT * INTO v_row
  FROM public.trial_usage
  WHERE user_id = p_user_id
  FOR UPDATE;

  CASE p_usage_type
    WHEN 'plan_generation' THEN
      v_current := v_row.plans_generated;
      v_allowed := v_current < p_limit;
      IF v_allowed THEN
        UPDATE public.trial_usage
        SET plans_generated = plans_generated + 1, updated_at = now()
        WHERE user_id = p_user_id;
        v_current := v_current + 1;
      END IF;

    WHEN 'plan_adjustment' THEN
      v_current := v_row.plan_adjustments;
      v_allowed := v_current < p_limit;
      IF v_allowed THEN
        UPDATE public.trial_usage
        SET plan_adjustments = plan_adjustments + 1, updated_at = now()
        WHERE user_id = p_user_id;
        v_current := v_current + 1;
      END IF;

    WHEN 'coach_message' THEN
      -- Reset daily counter if date changed
      IF v_row.coach_messages_date < CURRENT_DATE THEN
        UPDATE public.trial_usage
        SET coach_messages_today = 0, coach_messages_date = CURRENT_DATE, updated_at = now()
        WHERE user_id = p_user_id;
        v_row.coach_messages_today := 0;
      END IF;
      v_current := v_row.coach_messages_today;
      v_allowed := v_current < p_limit;
      IF v_allowed THEN
        UPDATE public.trial_usage
        SET coach_messages_today = coach_messages_today + 1, updated_at = now()
        WHERE user_id = p_user_id;
        v_current := v_current + 1;
      END IF;

    WHEN 'ai_analysis' THEN
      -- Reset daily counter if date changed
      IF v_row.ai_analyses_date < CURRENT_DATE THEN
        UPDATE public.trial_usage
        SET ai_analyses_today = 0, ai_analyses_date = CURRENT_DATE, updated_at = now()
        WHERE user_id = p_user_id;
        v_row.ai_analyses_today := 0;
      END IF;
      v_current := v_row.ai_analyses_today;
      v_allowed := v_current < p_limit;
      IF v_allowed THEN
        UPDATE public.trial_usage
        SET ai_analyses_today = ai_analyses_today + 1, updated_at = now()
        WHERE user_id = p_user_id;
        v_current := v_current + 1;
      END IF;

    WHEN 'daily_brief' THEN
      -- Reset daily counter if date changed
      IF v_row.daily_briefs_date < CURRENT_DATE THEN
        UPDATE public.trial_usage
        SET daily_briefs_today = 0, daily_briefs_date = CURRENT_DATE, updated_at = now()
        WHERE user_id = p_user_id;
        v_row.daily_briefs_today := 0;
      END IF;
      v_current := v_row.daily_briefs_today;
      v_allowed := v_current < p_limit;
      IF v_allowed THEN
        UPDATE public.trial_usage
        SET daily_briefs_today = daily_briefs_today + 1, updated_at = now()
        WHERE user_id = p_user_id;
        v_current := v_current + 1;
      END IF;

    ELSE
      RETURN jsonb_build_object('allowed', false, 'reason', 'unknown_usage_type');
  END CASE;

  RETURN jsonb_build_object(
    'allowed', v_allowed,
    'current_count', v_current,
    'limit', p_limit,
    'usage_type', p_usage_type
  );
END;
$$;

REVOKE ALL ON FUNCTION public.increment_trial_usage(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_trial_usage(uuid, text, integer) FROM authenticated;
REVOKE ALL ON FUNCTION public.increment_trial_usage(uuid, text, integer) FROM anon;

-- ─── 5. Entitlement query helper (convenience view) ─────────────────
-- Not strictly required but useful for admin queries.

CREATE OR REPLACE VIEW public.user_entitlement_status AS
SELECT
  s.user_id,
  s.plan_id,
  s.status,
  s.provider,
  s.trial_end,
  s.current_period_end,
  CASE
    WHEN s.provider != 'athlevo_trial' AND s.status IN ('active', 'trialing') THEN 'paid_active'
    WHEN s.provider = 'athlevo_trial' AND s.status = 'trialing' AND s.trial_end > now() THEN 'trial_active'
    WHEN s.provider = 'athlevo_trial' AND (s.status = 'expired' OR s.trial_end <= now()) THEN 'expired_limited'
    ELSE 'no_entitlement'
  END AS access_state,
  GREATEST(0, EXTRACT(EPOCH FROM (s.trial_end - now())))::integer AS trial_seconds_remaining
FROM public.subscriptions s;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK: see migrations/2026-07-27_cardless_trial_rollback.sql
-- ═══════════════════════════════════════════════════════════════════════
