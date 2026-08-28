-- Return event_type (activated | renewed) from apply_paymongo_payment so
-- server analytics can treat subscription_activated as first paid conversion.
-- Entitlement extension on renewal is unchanged.
--
-- Run manually after review. Safe to re-run (CREATE OR REPLACE).

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

revoke all on function public.apply_paymongo_payment(
  text, uuid, text, text, text, integer, text, text, timestamptz, text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.apply_paymongo_payment(
  text, uuid, text, text, text, integer, text, text, timestamptz, text, integer, jsonb
) to service_role;
