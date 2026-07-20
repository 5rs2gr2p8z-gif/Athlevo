-- Athlevo — provider_accounts (generic wearable/training-data connections)
--
-- Run this MANUALLY in Supabase. Nothing here runs automatically.
-- Additive and idempotent: it creates one NEW table and never touches
-- strava_accounts, activities, training plans, or any existing data.
--
-- WHY A NEW TABLE (and not a new intervals_accounts table):
--   strava_accounts is Strava-shaped (strava_athlete_id, Strava's refresh
--   token + expiry). Rather than clone it per provider, this is the
--   provider-neutral table the existing wearable provider abstraction always
--   implied. Strava intentionally KEEPS using strava_accounts — this
--   migration does not migrate or duplicate it, so the working Strava flow is
--   untouched. Future providers reuse this table with no further migration.

create table if not exists public.provider_accounts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  provider            text not null,               -- 'intervals' | future keys
  provider_athlete_id text,                        -- provider's athlete id
  access_token        text,
  refresh_token       text,                        -- null for Intervals.icu
  token_expires_at    timestamptz,                 -- null for Intervals.icu
  scope               text,
  status              text not null default 'connected',
                                                   -- connected | reconnect_required
  last_sync_at        timestamptz,                 -- newest activity date synced
  last_sync_status    text,
  sync_started_at     timestamptz,                 -- concurrency lock
  connected_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One connection per (athlete, provider). This is what the callback's
-- upsert (on_conflict=user_id,provider) requires, and it makes a duplicate
-- connection structurally impossible rather than merely unlikely.
create unique index if not exists provider_accounts_user_provider_uidx
  on public.provider_accounts (user_id, provider);

-- Ownership lookup: blocks silently linking ONE external provider account to
-- TWO different Athlevo accounts. Non-unique so existing data can never block
-- this migration; the hard check lives in the callback (belt and braces).
create index if not exists provider_accounts_provider_athlete_idx
  on public.provider_accounts (provider, provider_athlete_id);

-- RLS: the server uses the service role (which bypasses RLS) for all token
-- handling. Tokens must NEVER be readable by the browser, so there is
-- deliberately NO select policy for authenticated users — enabling RLS with
-- no policy denies all client access, which is exactly what we want.
alter table public.provider_accounts enable row level security;

-- Optional hardening. Enable ONLY after confirming no two Athlevo users share
-- a provider_athlete_id, otherwise index creation errors. Left COMMENTED so
-- this migration is always safe to run as-is:
--
--   create unique index if not exists provider_accounts_provider_athlete_uidx
--     on public.provider_accounts (provider, provider_athlete_id);

-- Note: no change is required to `activities`. Intervals.icu rows reuse the
-- existing (source, external_activity_id) identity with source='intervals',
-- and all richer fields live in the existing raw_data jsonb.
