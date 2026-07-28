-- Athlevo — Cardless Trial ROLLBACK
-- Run MANUALLY in Supabase SQL Editor if you need to undo the forward migration.
--
-- This rollback:
--   * Drops the convenience view, usage increment RPC, trial_usage table, and trial creation RPC
--   * Restores the subscription_events event_type constraint to the founding-beta version
--   * Does NOT delete any subscription or event rows (preserves trial history)
--   * Does NOT disable RLS on unrelated tables
--   * Does NOT weaken existing subscription security

-- 1. Drop the convenience view
DROP VIEW IF EXISTS public.user_entitlement_status;

-- 2. Drop the usage increment RPC
DROP FUNCTION IF EXISTS public.increment_trial_usage(uuid, text, integer);

-- 3. Drop the trial_usage table (RLS policies dropped automatically with table)
DROP TABLE IF EXISTS public.trial_usage;

-- 4. Drop the trial creation RPC
DROP FUNCTION IF EXISTS public.start_cardless_trial(uuid);

-- 5. Restore the event_type constraint to the founding-beta version
--    (removes cardless_trial_started, cardless_trial_expired, upgrade_from_trial, trial_expired)
--    NOTE: This will fail if any rows use the new event types. If trial events
--    exist in production, comment this section out and leave the wider constraint.
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
