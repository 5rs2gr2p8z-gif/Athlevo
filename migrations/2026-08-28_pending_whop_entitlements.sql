-- Athlevo — durable unmatched Whop purchases (pay-before-signup).
-- Run MANUALLY in Supabase SQL Editor. Additive only; nothing auto-applies.
--
-- WHY
--   The Whop webhook previously ACK'd unmatched checkout emails with 200 and
--   wrote nothing claimable. Anonymous /ai buyers could pay, then lose access
--   because auth.users did not exist yet. This table stores SERVER-VERIFIED
--   Whop state (signed webhook ± Whop API) so signup can bind it once.
--
-- SECURITY
--   RLS on, no policies: browsers cannot read or claim rows. Writes are
--   service-role only (webhook + claim endpoint). The claim RPC is granted
--   to service_role only; the HTTP handler supplies auth.uid() + the
--   authenticated email. Clients cannot pass an arbitrary email.

create table if not exists public.pending_whop_entitlements (
  id uuid primary key default gen_random_uuid(),

  -- Checkout email, lowercased to match findUserIdByEmail / auth.users.
  email text not null check (char_length(email) between 3 and 320),

  -- Whop membership identity. UNIQUE constraint (not only an index) so
  -- PostgREST on_conflict=whop_membership_id upserts are accepted.
  whop_membership_id text not null,
  whop_customer_id text,
  whop_plan_id text,

  -- Mapped Athlevo plan + lifecycle (same vocabulary as subscriptions).
  plan_id text not null default 'performance',
  effect text not null,
  event_type text,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  billing_interval text,

  -- Exact columns the webhook would have written to subscriptions.
  subscription_patch jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  last_provider_event_id text,

  claimed_user_id uuid references auth.users (id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pending_whop_entitlements
  drop constraint if exists pending_whop_entitlements_membership_key;
alter table public.pending_whop_entitlements
  add constraint pending_whop_entitlements_membership_key unique (whop_membership_id);

create index if not exists pending_whop_entitlements_email_unclaimed_idx
  on public.pending_whop_entitlements (email, updated_at desc)
  where claimed_at is null;

create index if not exists pending_whop_entitlements_claimed_user_idx
  on public.pending_whop_entitlements (claimed_user_id)
  where claimed_user_id is not null;

alter table public.pending_whop_entitlements enable row level security;

comment on table public.pending_whop_entitlements is
  'Server-verified unmatched Whop memberships waiting for Athlevo signup. '
  'Service-role access only. Claimed exactly once by authenticated email match.';

-- Atomically bind unclaimed rows for a verified email to one user and upsert
-- the canonical subscriptions row. Two concurrent claims cannot double-grant.
create or replace function public.claim_pending_whop_entitlement(
  p_user_id uuid,
  p_email text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_auth_email text;
  v_row public.pending_whop_entitlements%rowtype;
  v_patch jsonb;
  v_already public.pending_whop_entitlements%rowtype;
begin
  if p_user_id is null or p_email is null or length(trim(p_email)) = 0 then
    return jsonb_build_object('ok', false, 'claimed', false, 'reason', 'invalid_state');
  end if;

  v_email := lower(trim(p_email));
  select lower(u.email) into v_auth_email
  from auth.users u
  where u.id = p_user_id;

  if v_auth_email is null or v_auth_email is distinct from v_email then
    return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'email_mismatch');
  end if;

  perform 1
  from public.pending_whop_entitlements
  where email = v_email
    and claimed_at is null
  for update;

  select * into v_already
  from public.pending_whop_entitlements
  where claimed_user_id = p_user_id
  order by claimed_at desc nulls last
  limit 1;

  select * into v_row
  from public.pending_whop_entitlements
  where email = v_email
    and claimed_at is null
    and status = 'active'
  order by updated_at desc
  limit 1;

  if v_row.id is null then
    if exists (
      select 1 from public.pending_whop_entitlements
      where email = v_email and claimed_at is null
    ) then
      return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'invalid_status');
    end if;
    if v_already.id is not null then
      return jsonb_build_object(
        'ok', true, 'claimed', true, 'reason', 'already_claimed',
        'membership_id', v_already.whop_membership_id
      );
    end if;
    return jsonb_build_object('ok', true, 'claimed', false, 'reason', 'no_pending_purchase');
  end if;

  v_patch := coalesce(v_row.subscription_patch, '{}'::jsonb);

  insert into public.subscriptions (
    user_id,
    plan_id,
    status,
    billing_interval,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    cancelled_at,
    started_at,
    provider,
    provider_customer_id,
    provider_subscription_id,
    provider_price_id,
    metadata,
    updated_at
  ) values (
    p_user_id,
    coalesce(v_patch->>'plan_id', v_row.plan_id, 'performance'),
    coalesce(v_patch->>'status', v_row.status, 'active'),
    coalesce(v_patch->>'billing_interval', v_row.billing_interval, 'monthly'),
    coalesce((v_patch->>'current_period_start')::timestamptz, v_row.current_period_start),
    coalesce((v_patch->>'current_period_end')::timestamptz, v_row.current_period_end),
    coalesce((v_patch->>'cancel_at_period_end')::boolean, v_row.cancel_at_period_end, false),
    coalesce((v_patch->>'cancelled_at')::timestamptz, v_row.cancelled_at),
    coalesce((v_patch->>'started_at')::timestamptz, now()),
    'whop',
    coalesce(v_patch->>'provider_customer_id', v_row.whop_customer_id),
    coalesce(v_patch->>'provider_subscription_id', v_row.whop_membership_id),
    coalesce(v_patch->>'provider_price_id', v_row.whop_plan_id),
    coalesce(v_patch->'metadata', v_row.metadata, '{}'::jsonb),
    now()
  )
  on conflict (user_id) do update set
    plan_id = excluded.plan_id,
    status = excluded.status,
    billing_interval = excluded.billing_interval,
    current_period_start = excluded.current_period_start,
    current_period_end = excluded.current_period_end,
    cancel_at_period_end = excluded.cancel_at_period_end,
    cancelled_at = excluded.cancelled_at,
    started_at = coalesce(public.subscriptions.started_at, excluded.started_at),
    provider = excluded.provider,
    provider_customer_id = excluded.provider_customer_id,
    provider_subscription_id = excluded.provider_subscription_id,
    provider_price_id = excluded.provider_price_id,
    metadata = excluded.metadata,
    updated_at = now();

  begin
    insert into public.subscription_events (
      user_id, event_type, to_plan, to_status, provider, provider_event_id, metadata
    ) values (
      p_user_id,
      'activated',
      coalesce(v_patch->>'plan_id', v_row.plan_id, 'performance'),
      coalesce(v_patch->>'status', 'active'),
      'whop',
      'whop_claim:' || v_row.whop_membership_id,
      jsonb_build_object('source', 'whop_claim')
    );
  exception when unique_violation then
    null;
  end;

  update public.pending_whop_entitlements
  set claimed_user_id = p_user_id,
      claimed_at = now(),
      updated_at = now()
  where email = v_email
    and claimed_at is null;

  return jsonb_build_object(
    'ok', true,
    'claimed', true,
    'reason', 'claimed',
    'membership_id', v_row.whop_membership_id
  );
end;
$$;

revoke all on function public.claim_pending_whop_entitlement(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_pending_whop_entitlement(uuid, text) to service_role;

-- Diagnostic / pay-before-signup users must not receive the 24h performance
-- trial while an unmatched Whop purchase is waiting to be claimed.
-- Paid Whop rows still outrank the trial inside resolveEntitlement.
create or replace function public.ensure_free_trial(p_user_id uuid)
returns setof public.subscriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.subscriptions%rowtype;
begin
  select * into v_row
  from public.subscriptions
  where user_id = p_user_id;

  if not found then
    if exists (
      select 1
      from public.pending_whop_entitlements p
      join auth.users u on lower(u.email) = p.email
      where u.id = p_user_id
        and p.claimed_at is null
    ) then
      return;
    end if;
    insert into public.subscriptions (
      user_id, plan_id, status, billing_interval, trial_started_at
    ) values (
      p_user_id, 'free', 'active', 'none', now()
    )
    on conflict (user_id) do update
      set trial_started_at = coalesce(public.subscriptions.trial_started_at, now()),
          updated_at = now()
    returning * into v_row;
  elsif v_row.trial_started_at is null then
    update public.subscriptions
    set trial_started_at = now(),
        updated_at = now()
    where user_id = p_user_id
    returning * into v_row;
  end if;

  return next v_row;
end;
$$;
