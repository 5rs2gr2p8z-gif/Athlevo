-- Athlevo Free tier activation flag.
-- Run this MANUALLY in Supabase. Additive only.
--
-- Root cause this supports: the pricing screen's "Start Free" previously
-- recorded free-tier choice only on athlete_diagnostics (acquisition_stage
-- = 'completed'), a table that only has a row for athletes who went
-- through the pre-signup AI diagnostic funnel. Any athlete who reached
-- pricing another way (plain signup -> onboarding -> pricing) had no
-- athlete_diagnostics row, so the write silently no-op'd (UPDATE matched
-- zero rows) and the very next routeAfterAuth() found no paid subscription
-- and no diagnostic row, and sent them straight back to the paywall.
--
-- free_tier_started_at is a durable, canonical marker on profiles (which
-- every authenticated athlete already has a row for, and which the client
-- already updates for itself, e.g. profile_photo_url) recording that this
-- athlete explicitly chose Athlevo Free at the pricing screen. It does not
-- change entitlement: js/features.js and lib/server/features.js already
-- treat "no paid subscription row" as the Free plan by default. This flag
-- only lets the router stop showing the paywall once an athlete has made
-- that choice.

alter table public.profiles
  add column if not exists free_tier_started_at timestamptz;

create index if not exists profiles_free_tier_started_at_idx
  on public.profiles (free_tier_started_at)
  where free_tier_started_at is not null;

comment on column public.profiles.free_tier_started_at is
  'Set once, client-side, when the athlete chooses "Start Free" at the pricing screen. Null means the athlete has not yet made a pricing choice (still paywalled) unless they have a paid subscription. Never cleared by upgrading to paid.';
