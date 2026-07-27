/*
 * ══════════════════════════════════════════════════════════════════════
 *  Athlevo — Rollback 001: Drop Atomic Rate-Limit RPC Function
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Reverses migration 001. Drops only the exact function signature
 *  introduced by 001-atomic-rate-limit-rpc.sql.
 *
 *  SCOPE:  Does NOT touch tables, RLS, or athlete-table policies.
 *
 *  EFFECT: After rollback, rateLimit.js falls back to the legacy
 *          read-then-upsert path (non-atomic but functional).
 *
 *  IDEMPOTENT: IF EXISTS — safe to run multiple times.
 */

DROP FUNCTION IF EXISTS public.increment_rate_limit(uuid, text, timestamptz, integer);
