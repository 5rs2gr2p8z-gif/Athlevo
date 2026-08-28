-- Athlevo PayMongo V1 — additive entitlement and payment ledger migration.
-- Run manually in Supabase before enabling the PayMongo endpoints.

alter table public.subscriptions
  add column if not exists paid_until timestamptz;

create index if not exists subscriptions_paid_until_idx
  on public.subscriptions (paid_until);

update public.subscription_plans
set monthly_price_cents = 59700,
    currency = 'PHP',
    updated_at = now()
where id = 'performance';

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null
    check (provider in ('paymongo', 'whop', 'gcash_manual')),
  provider_payment_id text,
  provider_checkout_id text,
  reference_number text,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'PHP',
  status text not null
    check (status in ('pending', 'paid', 'refunded', 'failed', 'expired')),
  payment_method_type text,
  entitlement_days integer check (entitlement_days is null or entitlement_days > 0),
  product_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz
);

create unique index if not exists payment_transactions_provider_payment_uidx
  on public.payment_transactions (provider, provider_payment_id)
  where provider_payment_id is not null;
create unique index if not exists payment_transactions_provider_checkout_uidx
  on public.payment_transactions (provider, provider_checkout_id)
  where provider_checkout_id is not null;
create unique index if not exists payment_transactions_reference_uidx
  on public.payment_transactions (reference_number)
  where reference_number is not null;
create index if not exists payment_transactions_user_idx
  on public.payment_transactions (user_id, created_at desc);

alter table public.payment_transactions enable row level security;

drop policy if exists "Athletes read own payment transactions"
  on public.payment_transactions;
create policy "Athletes read own payment transactions"
  on public.payment_transactions for select
  using (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policy is intentionally created. Only the service
-- role used by verified server endpoints may mutate payment or entitlement data.

-- Atomically mark one known checkout paid, extend prepaid access once, and
-- claim the provider event. Existing Whop lifecycle/provider fields are kept.
create or replace function public.apply_paymongo_payment(
  p_event_id text,
  p_user_id uuid,
  p_checkout_id text,
  p_payment_id text,
  p_reference_number text,
  p_amount_cents integer,
  p_currency text,
  p_payment_method_type text,
  p_paid_at timestamptz,
  p_product_id text,
  p_entitlement_days integer,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_transaction public.payment_transactions%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_base timestamptz;
  v_paid_until timestamptz;
  v_is_new_subscription boolean := false;
  v_already_paid boolean := false;
  v_event_type text;
begin
  if p_amount_cents <> 59700 or upper(p_currency) <> 'PHP'
     or p_product_id <> 'ATHLEVO_PRO_MONTHLY' or p_entitlement_days <> 30 then
    raise exception 'paymongo product validation failed';
  end if;

  select * into v_transaction
  from public.payment_transactions
  where provider = 'paymongo'
    and user_id = p_user_id
    and provider_checkout_id = p_checkout_id
    and reference_number = p_reference_number
  for update;

  if not found then
    raise exception 'known pending checkout not found';
  end if;
  if v_transaction.amount_cents <> p_amount_cents
     or upper(v_transaction.currency) <> upper(p_currency)
     or v_transaction.product_id <> p_product_id
     or v_transaction.entitlement_days <> p_entitlement_days then
    raise exception 'pending checkout mismatch';
  end if;

  if v_transaction.status = 'paid'
     and coalesce((v_transaction.metadata ->> 'entitlement_applied')::boolean, false) then
    return jsonb_build_object(
      'applied', false,
      'duplicate', true,
      'paid_until', v_transaction.metadata ->> 'entitlement_applied_until'
    );
  end if;
  if v_transaction.status <> 'pending' then
    raise exception 'checkout is not payable';
  end if;

  select * into v_subscription
  from public.subscriptions
  where user_id = p_user_id
  for update;

  if not found then
    v_is_new_subscription := true;
    v_already_paid := false;
    v_base := greatest(now(), coalesce(p_paid_at, now()));
    v_paid_until := v_base + make_interval(days => p_entitlement_days);
    insert into public.subscriptions (
      user_id, plan_id, status, billing_interval, provider, paid_until, metadata, updated_at
    ) values (
      p_user_id, 'performance', 'active', 'none', 'paymongo', v_paid_until,
      jsonb_build_object('last_paymongo_payment_id', p_payment_id), now()
    ) returning * into v_subscription;
  else
    v_already_paid := v_subscription.plan_id is distinct from 'free'
      and lower(coalesce(v_subscription.provider, '')) in ('whop', 'paymongo', 'gcash_manual')
      and lower(coalesce(v_subscription.status, '')) = 'active';
    v_base := greatest(
      now(),
      coalesce(p_paid_at, now()),
      case when v_subscription.paid_until > now() then v_subscription.paid_until else now() end,
      case when v_subscription.current_period_end > now() then v_subscription.current_period_end else now() end
    );
    v_paid_until := v_base + make_interval(days => p_entitlement_days);
    update public.subscriptions
    set plan_id = 'performance',
        status = case
          when plan_id = 'free' or provider = 'paymongo' or provider is null
            or provider not in ('whop', 'gcash_manual', 'paymongo') then 'active'
          else status
        end,
        provider = case
          when plan_id = 'free' or provider is null
            or provider not in ('whop', 'gcash_manual', 'paymongo') then 'paymongo'
          else provider
        end,
        paid_until = v_paid_until,
        metadata = metadata || jsonb_build_object('last_paymongo_payment_id', p_payment_id),
        updated_at = now()
    where user_id = p_user_id
    returning * into v_subscription;
  end if;

  update public.payment_transactions
  set provider_payment_id = p_payment_id,
      status = 'paid',
      payment_method_type = p_payment_method_type,
      paid_at = coalesce(p_paid_at, now()),
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object(
        'entitlement_applied', true,
        'entitlement_applied_until', v_paid_until,
        'whop_period_end_at_payment', v_subscription.current_period_end
      )
  where id = v_transaction.id;

  v_event_type := case when v_already_paid then 'renewed' else 'activated' end;

  insert into public.subscription_events (
    user_id, subscription_id, event_type, to_plan, to_status,
    provider, provider_event_id, metadata
  ) values (
    p_user_id, v_subscription.id,
    v_event_type,
    v_subscription.plan_id, v_subscription.status,
    'paymongo', p_event_id,
    jsonb_build_object(
      'payment_transaction_id', v_transaction.id,
      'product_id', p_product_id,
      'entitlement_days', p_entitlement_days
    )
  ) on conflict (provider, provider_event_id) do nothing;

  return jsonb_build_object(
    'applied', true,
    'duplicate', false,
    'paid_until', v_paid_until,
    'event_type', v_event_type
  );
end;
$$;

-- A full refund removes only the refunded PayMongo transaction, then rebuilds
-- paid_until from the remaining paid PayMongo ledger. current_period_end and
-- all Whop identifiers/lifecycle values are deliberately untouched.
create or replace function public.apply_paymongo_refund(
  p_event_id text,
  p_payment_id text,
  p_refunded_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_transaction public.payment_transactions%rowtype;
  v_subscription public.subscriptions%rowtype;
  v_item record;
  v_paid_until timestamptz := null;
  v_paid_at timestamptz;
  v_whop_base timestamptz;
begin
  select * into v_transaction
  from public.payment_transactions
  where provider = 'paymongo' and provider_payment_id = p_payment_id
  for update;

  if not found then
    raise exception 'paid transaction not found';
  end if;
  if v_transaction.status = 'refunded' then
    return jsonb_build_object('applied', false, 'duplicate', true);
  end if;
  if v_transaction.status <> 'paid' then
    raise exception 'transaction is not refundable';
  end if;

  select * into v_subscription
  from public.subscriptions
  where user_id = v_transaction.user_id
  for update;

  update public.payment_transactions
  set status = 'refunded',
      refunded_at = coalesce(p_refunded_at, now()),
      metadata = metadata || coalesce(p_metadata, '{}'::jsonb)
  where id = v_transaction.id;

  for v_item in
    select paid_at, created_at, entitlement_days, metadata
    from public.payment_transactions
    where provider = 'paymongo'
      and user_id = v_transaction.user_id
      and status = 'paid'
    order by coalesce(paid_at, created_at), id
  loop
    v_paid_at := coalesce(v_item.paid_at, v_item.created_at);
    begin
      v_whop_base := nullif(v_item.metadata ->> 'whop_period_end_at_payment', '')::timestamptz;
    exception when others then
      v_whop_base := null;
    end;
    v_paid_until := greatest(
      coalesce(v_paid_until, v_paid_at),
      v_paid_at,
      coalesce(v_whop_base, v_paid_at)
    ) + make_interval(days => v_item.entitlement_days);
  end loop;

  update public.subscriptions
  set paid_until = v_paid_until,
      status = case
        when provider = 'paymongo' then case
          when v_paid_until > now() or current_period_end > now() then 'active'
          else 'expired'
        end
        else status
      end,
      updated_at = now()
  where user_id = v_transaction.user_id;

  insert into public.subscription_events (
    user_id, subscription_id, event_type, to_plan, to_status,
    provider, provider_event_id, metadata
  ) values (
    v_transaction.user_id, v_subscription.id, 'cancelled',
    v_subscription.plan_id, v_subscription.status,
    'paymongo', p_event_id,
    jsonb_build_object(
      'payment_transaction_id', v_transaction.id,
      'refund_scope', 'paymongo_transaction_only'
    )
  ) on conflict (provider, provider_event_id) do nothing;

  return jsonb_build_object(
    'applied', true,
    'duplicate', false,
    'paid_until', v_paid_until
  );
end;
$$;

revoke all on function public.apply_paymongo_payment(
  text, uuid, text, text, text, integer, text, text, timestamptz, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_paymongo_payment(
  text, uuid, text, text, text, integer, text, text, timestamptz, text, integer, jsonb
) to service_role;

revoke all on function public.apply_paymongo_refund(
  text, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_paymongo_refund(
  text, text, timestamptz, jsonb
) to service_role;
