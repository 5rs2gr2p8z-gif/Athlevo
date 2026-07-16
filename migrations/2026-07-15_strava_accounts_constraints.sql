-- Athlevo — strava_accounts constraints & ownership lookup.
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
-- Additive and idempotent — it never deletes, overwrites, or unlinks any
-- existing valid Strava connection.
--
-- The strava_accounts table already exists (it was created outside the
-- migrations folder). This migration only ENSURES the constraints/indexes
-- the callback depends on for reliable multi-user, multi-athlete behaviour.

-- 1) One connection per Athlevo user. This is what the callback's
--    upsert (on_conflict=user_id) requires. Safe/idempotent: if an
--    equivalent unique already exists this is a harmless duplicate. It will
--    only fail if genuine duplicate user_id rows already exist — which would
--    be a pre-existing data bug to resolve first (do not force it).
create unique index if not exists strava_accounts_user_id_uidx
  on public.strava_accounts (user_id);

-- 2) Fast ownership lookup by Strava athlete id — used by the callback to
--    block linking one Strava athlete to two different Athlevo users. NOT
--    unique, so existing data can never block this migration; athlete-level
--    ownership is enforced in the callback code (belt and suspenders).
create index if not exists strava_accounts_athlete_idx
  on public.strava_accounts (strava_athlete_id);

-- 3) OPTIONAL database-level guarantee (defense in depth). Enable ONLY after
--    confirming no two rows share a strava_athlete_id across different users,
--    otherwise index creation will error. Left COMMENTED so this migration is
--    always safe to run as-is:
--
--   create unique index if not exists strava_accounts_athlete_uidx
--     on public.strava_accounts (strava_athlete_id);

-- Notes:
--   * strava_athlete_id should be a bigint (Strava athlete ids exceed int4).
--     If the column is currently a narrower integer type, widen it separately
--     and deliberately — this migration does not ALTER column types.
--   * The server (service role) bypasses RLS to read/write this table in the
--     callback; no RLS change is required here.
