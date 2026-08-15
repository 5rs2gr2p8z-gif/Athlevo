-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — Coach → athlete email invitations
-- ══════════════════════════════════════════════════════════════════════
--
-- Pending invitations are deliberately separate from
-- coach_athlete_assignments. A pending token grants no athlete access; the
-- active assignment is created only by the atomic service-role RPC below.

create table if not exists public.coach_athlete_invites (
  id               uuid primary key default gen_random_uuid(),
  coach_id         uuid not null references auth.users (id) on delete cascade,
  email_normalized text not null,
  token_hash       text not null,
  permission_level text not null default 'read_write'
                     check (permission_level in ('read', 'read_write')),
  status           text not null default 'pending'
                     check (status in ('pending', 'accepted', 'expired', 'revoked')),
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  accepted_at      timestamptz,
  revoked_at       timestamptz,
  accepted_by      uuid references auth.users (id) on delete set null
);

create unique index if not exists coach_athlete_invites_token_hash_unique
  on public.coach_athlete_invites (token_hash);

create unique index if not exists coach_athlete_invites_pending_coach_email_unique
  on public.coach_athlete_invites (coach_id, email_normalized)
  where status = 'pending';

create index if not exists coach_athlete_invites_pending_email_idx
  on public.coach_athlete_invites (email_normalized)
  where status = 'pending';

alter table public.coach_athlete_invites enable row level security;

-- No browser policies are defined. With RLS enabled this is default-deny for
-- select/insert/update/delete; the reviewed server gateway uses service_role.

-- Exact, non-enumerating relationship check used by the service gateway.
-- It only answers whether THIS coach already has THIS email on their active
-- roster and never returns an auth user or email row.
create or replace function public.athlevo_invite_has_active_relationship(
  p_coach_id uuid,
  p_email_normalized text
)
returns boolean
language sql
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from auth.users u
      join public.coach_athlete_assignments a on a.athlete_id = u.id
     where a.coach_id = p_coach_id
       and a.status = 'active'
       and lower(trim(u.email)) = lower(trim(p_email_normalized))
  );
$$;

-- Accepting is one database transaction: lock token, validate state/email,
-- insert the active assignment, then consume the invite. Any error rolls the
-- whole operation back, so an accepted invite can never exist without its
-- assignment and a replay can never create a second assignment.
create or replace function public.athlevo_accept_coach_invite(
  p_token_hash text,
  p_athlete_id uuid,
  p_email_normalized text
)
returns table (
  result_state text,
  invite_id uuid,
  result_coach_id uuid,
  result_assignment_id uuid,
  result_permission_level text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_invite public.coach_athlete_invites%rowtype;
  v_assignment_id uuid;
begin
  select * into v_invite
    from public.coach_athlete_invites
   where token_hash = p_token_hash
   for update;

  if not found then
    return query select 'invalid'::text, null::uuid, null::uuid, null::uuid, null::text;
    return;
  end if;

  if v_invite.status = 'accepted' then
    select a.id into v_assignment_id
      from public.coach_athlete_assignments a
     where a.coach_id = v_invite.coach_id
       and a.athlete_id = v_invite.accepted_by
       and a.status = 'active'
     order by a.assigned_at desc
     limit 1;
    return query select 'accepted'::text, v_invite.id, v_invite.coach_id,
      v_assignment_id, v_invite.permission_level;
    return;
  end if;

  if v_invite.status = 'revoked' then
    return query select 'revoked'::text, v_invite.id, v_invite.coach_id,
      null::uuid, v_invite.permission_level;
    return;
  end if;

  if v_invite.status = 'expired' or v_invite.expires_at <= now() then
    return query select 'expired'::text, v_invite.id, v_invite.coach_id,
      null::uuid, v_invite.permission_level;
    return;
  end if;

  if lower(trim(coalesce(p_email_normalized, ''))) <> v_invite.email_normalized then
    return query select 'wrong_email'::text, v_invite.id, v_invite.coach_id,
      null::uuid, v_invite.permission_level;
    return;
  end if;

  if p_athlete_id is null or p_athlete_id = v_invite.coach_id then
    return query select 'conflict'::text, v_invite.id, v_invite.coach_id,
      null::uuid, v_invite.permission_level;
    return;
  end if;

  if exists (
    select 1 from public.coach_athlete_assignments a
     where a.coach_id = v_invite.coach_id
       and a.athlete_id = p_athlete_id
       and a.status in ('invited', 'active', 'paused')
  ) then
    return query select 'already_on_roster'::text, v_invite.id, v_invite.coach_id,
      null::uuid, v_invite.permission_level;
    return;
  end if;

  begin
    insert into public.coach_athlete_assignments (
      coach_id, athlete_id, status, permission_level, created_by, assigned_at
    ) values (
      v_invite.coach_id, p_athlete_id, 'active',
      v_invite.permission_level, v_invite.coach_id, now()
    )
    returning id into v_assignment_id;
  exception when unique_violation then
    -- A concurrent acceptance/admin write won the live-pair constraint.
    -- Leave this invite pending and report the friendly conflict state.
    return query select 'already_on_roster'::text, v_invite.id, v_invite.coach_id,
      null::uuid, v_invite.permission_level;
    return;
  end;

  update public.coach_athlete_invites
     set status = 'accepted',
         accepted_at = now(),
         accepted_by = p_athlete_id
   where id = v_invite.id;

  return query select 'accepted_now'::text, v_invite.id, v_invite.coach_id,
    v_assignment_id, v_invite.permission_level;
end;
$$;

revoke all on function public.athlevo_invite_has_active_relationship(uuid, text)
  from public, anon, authenticated;
revoke all on function public.athlevo_accept_coach_invite(text, uuid, text)
  from public, anon, authenticated;

grant execute on function public.athlevo_invite_has_active_relationship(uuid, text)
  to service_role;
grant execute on function public.athlevo_accept_coach_invite(text, uuid, text)
  to service_role;
