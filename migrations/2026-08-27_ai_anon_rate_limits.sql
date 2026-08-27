-- Athlevo — anonymous (pre-signup) AI rate limits.
-- Run this MANUALLY in Supabase. Additive and idempotent.
--
-- Why a separate table: public.ai_rate_limits.user_id is a UUID FK to
-- auth.users, so the pre-signup diagnostic chat cannot reuse it. This
-- table keys on a hashed client identifier (never a raw IP).

create table if not exists public.ai_anon_rate_limits (
  client_key text not null,
  endpoint text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (client_key, endpoint, window_start),
  constraint ai_anon_rate_limits_key_len check (
    char_length(client_key) >= 8 and char_length(client_key) <= 80
  ),
  constraint ai_anon_rate_limits_endpoint_len check (
    char_length(endpoint) >= 1 and char_length(endpoint) <= 80
  )
);

create index if not exists ai_anon_rate_limits_window_idx
  on public.ai_anon_rate_limits (window_start);

alter table public.ai_anon_rate_limits enable row level security;
