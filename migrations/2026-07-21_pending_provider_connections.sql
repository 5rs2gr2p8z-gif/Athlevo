-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — pending_provider_connections
-- ══════════════════════════════════════════════════════════════════════
--
--  WHY THIS TABLE EXISTS
--
--  The Intervals.icu OAuth callback is a provider redirect. It carries no
--  Supabase Bearer token, so the server CANNOT know which Athlevo account is
--  signed into the browser at that moment. Writing provider_accounts straight
--  from the callback therefore trusted the account that STARTED the flow.
--  If the browser session had changed in between, the row landed on the wrong
--  user: the write succeeded, every later read found nothing, and no error was
--  raised anywhere.
--
--  So the callback now parks the credentials here instead. The authenticated
--  client then calls ?action=finalize with its real Bearer token, and only a
--  verified identity match promotes the pending row into provider_accounts.
--
--  SAFETY
--    · idempotent — safe to run more than once
--    · non-destructive — creates only; touches no existing table or row
--    · service-role only — RLS on, deliberately NO policy, so no browser can
--      read a credential payload even with a valid user JWT
--
--  Credentials in `payload_encrypted` are AES-256-GCM ciphertext produced by
--  the server. This table never stores plaintext provider tokens.

create table if not exists public.pending_provider_connections (
  id                  uuid primary key default gen_random_uuid(),

  -- SHA-256 of the one-time completion token. The raw token exists only in
  -- the redirect URL and the client's memory; a database leak cannot be
  -- replayed against the finalize endpoint.
  token_hash          text        not null,

  -- The account that INITIATED the flow. finalize compares this against
  -- requireUser().id and refuses to promote the row when they differ.
  user_id             uuid        not null references auth.users(id) on delete cascade,

  provider            text        not null,
  provider_athlete_id text        not null,

  -- AES-256-GCM: iv.authTag.ciphertext, base64url. Never plaintext.
  payload_encrypted   text        not null,

  expires_at          timestamptz not null,
  consumed_at         timestamptz,
  created_at          timestamptz not null default now()
);

-- Lookup is always by token hash, and must be unique so a single-use consume
-- can rely on it.
create unique index if not exists pending_provider_connections_token_uidx
  on public.pending_provider_connections (token_hash);

-- Supports the expiry sweep.
create index if not exists pending_provider_connections_expiry_idx
  on public.pending_provider_connections (expires_at)
  where consumed_at is null;

-- Supports "does this athlete already have a pending attempt" checks.
create index if not exists pending_provider_connections_user_provider_idx
  on public.pending_provider_connections (user_id, provider);

-- RLS ON with NO policy = total denial for every client role. The service
-- role bypasses RLS, so the server keeps full access. This is intentional:
-- there is no legitimate reason for a browser to read this table.
alter table public.pending_provider_connections enable row level security;

comment on table public.pending_provider_connections is
  'Short-lived OAuth handoff. Holds encrypted provider credentials between the '
  'unauthenticated provider callback and the authenticated finalize call, so a '
  'connection can never be saved to an account that did not initiate it. '
  'Service-role access only.';
