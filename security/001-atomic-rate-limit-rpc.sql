/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Migration 001: Atomic Rate-Limit RPC Function
 * ══════════════════════════════════════════════════════════════════════
 *
 *  PURPOSE:  Create a SECURITY DEFINER function that atomically
 *            increments the rate-limit counter in one round-trip,
 *            eliminating the read-then-write race condition.
 *
 *  DEPENDS ON:  Table public.ai_rate_limits must already exist
 *               (created by migrations/2026-07-20_ai_rate_limits.sql).
 *
 *  CALLED BY:   lib/server/rateLimit.js via PostgREST RPC
 *               (supabase.rpc('increment_rate_limit', { ... }))
 *
 *  SCOPE:  This file contains ONLY the rate-limit RPC function.
 *          It does NOT touch RLS policies on athlete-owned tables.
 *
 *  SAFETY:
 *    - CREATE OR REPLACE is idempotent.
 *    - Function accepts identity via p_user_id (UUID from service-role
 *      caller), never from browser/client input.
 *    - search_path is pinned to prevent schema-hijacking.
 *    - Execution is revoked from public, anon, and authenticated.
 *      Only service_role (via PostgREST) can call this function.
 *
 *  ROLLBACK:  See 001-atomic-rate-limit-rpc-rollback.sql
 */

-- ═══════════════════════════════════════════════════════════════
-- Atomic rate-limit increment function
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.increment_rate_limit(
  p_user_id      uuid,
  p_endpoint     text,
  p_window_start timestamptz,
  p_limit        integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.ai_rate_limits (user_id, endpoint, window_start, request_count, updated_at)
  VALUES (p_user_id, p_endpoint, p_window_start, 1, now())
  ON CONFLICT (user_id, endpoint, window_start)
  DO UPDATE SET
    request_count = public.ai_rate_limits.request_count + 1,
    updated_at = now()
  RETURNING request_count INTO v_count;

  RETURN jsonb_build_object(
    'current_count', v_count,
    'allowed', v_count <= p_limit
  );
END;
$$;

-- ═══════════════════════════════════════════════════════════════
-- Permission hardening: service_role only
-- ═══════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION public.increment_rate_limit(uuid, text, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_rate_limit(uuid, text, timestamptz, integer) FROM anon;
REVOKE ALL ON FUNCTION public.increment_rate_limit(uuid, text, timestamptz, integer) FROM authenticated;

-- service_role inherits from authenticated in Supabase but also has
-- superuser-like bypass. Grant explicitly so the PostgREST service-role
-- bearer token can call this RPC.
GRANT EXECUTE ON FUNCTION public.increment_rate_limit(uuid, text, timestamptz, integer) TO service_role;
