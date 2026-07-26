-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — Admin: Grant Founding Beta access to specific users
-- ══════════════════════════════════════════════════════════════════════
--
--  Run in Supabase SQL Editor with the service role.
--  Replace the user IDs in the VALUES list with actual beta user UUIDs.
--  DO NOT run this without reviewing the list — it is intentionally
--  manual to prevent accidental mass grants.
--
--  Prerequisites:
--    1. Run migrations/2026-07-26_founding_beta.sql first.
--    2. If the user already has a Whop subscription row, this will NOT
--       overwrite it (ON CONFLICT … DO NOTHING). Paid users keep their
--       real subscription.

-- ─── Configuration ────────────────────────────────────────────────
-- Set the expiry. Default: 3 days from now.
-- Change the interval if you want a different duration.

DO $$
DECLARE
  beta_expires_at TIMESTAMPTZ := NOW() + INTERVAL '3 days';
  beta_user_ids   UUID[] := ARRAY[
    -- ┌─────────────────────────────────────────────────────────────┐
    -- │  REPLACE THESE with real user UUIDs from auth.users         │
    -- │  Example:                                                   │
    -- │    '550e8400-e29b-41d4-a716-446655440001'::uuid,            │
    -- │    '550e8400-e29b-41d4-a716-446655440002'::uuid             │
    -- └─────────────────────────────────────────────────────────────┘
  ];
  uid UUID;
BEGIN
  FOREACH uid IN ARRAY beta_user_ids LOOP
    -- Insert founding_beta subscription (skip if user already has one)
    INSERT INTO public.subscriptions (
      user_id,
      plan_id,
      status,
      billing_interval,
      is_founder,
      current_period_start,
      current_period_end,
      started_at,
      provider,
      metadata
    ) VALUES (
      uid,
      'founding_beta',
      'active',
      'none',
      true,
      NOW(),
      beta_expires_at,
      NOW(),
      'founding_beta',
      jsonb_build_object(
        'source',     'founding_beta',
        'granted_at', NOW()::text,
        'granted_by', 'admin_manual',
        'note',       'Founding beta: 3-day full access for early testers'
      )
    )
    ON CONFLICT (user_id) DO NOTHING;

    -- Log the grant event
    INSERT INTO public.subscription_events (
      user_id,
      subscription_id,
      event_type,
      from_plan,
      to_plan,
      from_status,
      to_status,
      provider,
      metadata
    )
    SELECT
      uid,
      s.id,
      'beta_granted',
      'free',
      'founding_beta',
      NULL,
      'active',
      'founding_beta',
      jsonb_build_object(
        'access_expires_at', beta_expires_at::text,
        'granted_by',        'admin_manual'
      )
    FROM public.subscriptions s
    WHERE s.user_id = uid AND s.plan_id = 'founding_beta';

  END LOOP;

  RAISE NOTICE 'Founding Beta granted to % user(s). Expires at %.',
    array_length(beta_user_ids, 1), beta_expires_at;
END $$;

-- ─── Verification query ───────────────────────────────────────────
-- Run after granting to confirm:

-- SELECT
--   s.user_id,
--   u.email,
--   s.plan_id,
--   s.status,
--   s.provider,
--   s.current_period_end,
--   s.metadata
-- FROM public.subscriptions s
-- JOIN auth.users u ON u.id = s.user_id
-- WHERE s.plan_id = 'founding_beta'
-- ORDER BY s.created_at DESC;
