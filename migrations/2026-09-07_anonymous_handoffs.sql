-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — anonymous cross-browser continuation handoffs
-- ══════════════════════════════════════════════════════════════════════
--
--  Purpose: let an anonymous visitor who talked to the pre-signup Coach in
--  a Meta in-app browser (Facebook/Messenger/Instagram) continue in Safari
--  or Chrome (required for Google OAuth / wearable connection) WITHOUT
--  losing what they already told Athlevo.
--
--  This table stores nothing but a short-lived, single-use, opaque-token-
--  addressed copy of the existing anonymous DiagnosticEngine payload
--  (see js/diagnostic.js toStoredPayload()) — the same shape already kept
--  in this browser's own localStorage. It is not a new diagnostic schema.
--
--  Security model:
--  - The raw continuation token is never stored — only its sha256 hash
--    (token_hash). Only a server holding the raw token (from the URL) can
--    ever match a row.
--  - Row Level Security is enabled with ZERO policies and ZERO grants to
--    anon/authenticated. Only the service_role key (used server-side only,
--    via lib/server/anonymousHandoffEndpoint.js) can read or write this
--    table. Mirrors migrations/2026-08-27_ai_anon_rate_limits.sql.
--  - expires_at enforces a short lifetime (20–30 minutes, set by the
--    application at insert time).
--  - consumed_at makes the token single-use: the consuming endpoint claims
--    the row with an atomic UPDATE ... WHERE consumed_at IS NULL, so a
--    replayed/leaked token cannot be consumed twice.
--  - No email, password, auth/access tokens, workout data, or free-text
--    conversation content is ever written into `payload` — the
--    application only ever writes the DiagnosticEngine's own categorical
--    export.
--
--  Additive only. No DROP. No changes to any existing table.
-- ══════════════════════════════════════════════════════════════════════

create table if not exists public.anonymous_handoffs (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  payload jsonb not null,
  source_browser text,
  source_surface text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint anonymous_handoffs_token_hash_len check (char_length(token_hash) = 64),
  constraint anonymous_handoffs_source_browser_chk check (
    source_browser is null or source_browser in ('facebook', 'instagram')
  ),
  constraint anonymous_handoffs_source_surface_chk check (
    source_surface is null or char_length(source_surface) <= 40
  ),
  constraint anonymous_handoffs_expiry_chk check (expires_at > created_at)
);

create unique index if not exists anonymous_handoffs_token_hash_idx
  on public.anonymous_handoffs (token_hash);

-- Supports the cleanup query below and any future scheduled cleanup job.
create index if not exists anonymous_handoffs_expires_at_idx
  on public.anonymous_handoffs (expires_at);

alter table public.anonymous_handoffs enable row level security;
-- Intentionally no policies: only the service_role key (server-side admin
-- headers, see lib/server/supabaseServer.js) can read/write this table.

-- ── Cleanup ──────────────────────────────────────────────────────────
-- No scheduled-job infrastructure exists in this project yet, so cleanup
-- is a plain retention query. Safe to run manually any time (e.g. from
-- the Supabase SQL editor, on a schedule you set up later via pg_cron or
-- a Vercel cron hitting a tiny admin endpoint). It only ever removes rows
-- that are already useless (expired, or consumed more than a day ago):
--
--   delete from public.anonymous_handoffs
--   where expires_at < now() - interval '1 day'
--      or (consumed_at is not null and consumed_at < now() - interval '1 day');
