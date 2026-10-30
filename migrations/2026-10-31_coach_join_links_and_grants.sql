-- ══════════════════════════════════════════════════════════════════════
--  Athlevo — coach join links + in-app coach grants
-- ══════════════════════════════════════════════════════════════════════
--  Additive and idempotent. Run once in the Supabase SQL editor.
--
--  1. coach_join_links: one active, shareable link per coach
--     (athlevo.org/?coach=<code>). An athlete who opens it and confirms
--     joins that coach's roster. Not tied to an email, so a coach can send
--     it over Messenger, WhatsApp or SMS. No email service needed.
--  2. athlevo_join_coach_by_code(): atomic join (service role only).
--  3. athlevo_set_role_by_email(): lets an ADMIN (checked in the API) make a
--     signed-up user a coach, or remove coach access. Service role only.
--
--  RLS is on with NO policies: only the server (service role) touches these.
-- ══════════════════════════════════════════════════════════════════════

create table if not exists public.coach_join_links (
  id          uuid primary key default gen_random_uuid(),
  coach_id    uuid not null references auth.users (id) on delete cascade,
  code        text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  rotated_at  timestamptz
);

create unique index if not exists coach_join_links_code_unique
  on public.coach_join_links (code);
create unique index if not exists coach_join_links_one_active_per_coach
  on public.coach_join_links (coach_id) where active;

alter table public.coach_join_links enable row level security;

create or replace function public.athlevo_join_coach_by_code(
  p_code text,
  p_athlete_id uuid
)
returns table (
  result_state text,
  result_coach_id uuid,
  result_assignment_id uuid
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_link public.coach_join_links%rowtype;
  v_assignment_id uuid;
begin
  select * into v_link
    from public.coach_join_links
   where code = p_code and active;

  if not found then
    return query select 'invalid'::text, null::uuid, null::uuid;
    return;
  end if;

  if p_athlete_id is null or p_athlete_id = v_link.coach_id then
    return query select 'conflict'::text, v_link.coach_id, null::uuid;
    return;
  end if;

  if exists (
    select 1 from public.coach_athlete_assignments a
     where a.coach_id = v_link.coach_id
       and a.athlete_id = p_athlete_id
       and a.status in ('invited', 'active', 'paused')
  ) then
    return query select 'already_on_roster'::text, v_link.coach_id, null::uuid;
    return;
  end if;

  -- One coach at a time: a second active coach would make the athlete's
  -- mode ambiguous. The current coach (or an admin) ends that first.
  if exists (
    select 1 from public.coach_athlete_assignments a
     where a.athlete_id = p_athlete_id
       and a.status = 'active'
  ) then
    return query select 'has_other_coach'::text, v_link.coach_id, null::uuid;
    return;
  end if;

  begin
    insert into public.coach_athlete_assignments (
      coach_id, athlete_id, status, permission_level, created_by, assigned_at
    ) values (
      v_link.coach_id, p_athlete_id, 'active', 'read_write', v_link.coach_id, now()
    )
    returning id into v_assignment_id;
  exception when unique_violation then
    return query select 'already_on_roster'::text, v_link.coach_id, null::uuid;
    return;
  end;

  return query select 'accepted_now'::text, v_link.coach_id, v_assignment_id;
end;
$$;

create or replace function public.athlevo_set_role_by_email(
  p_email text,
  p_role text
)
returns table (result_state text, result_user_id uuid, result_role text)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_user_id uuid;
  v_current text;
begin
  if p_role not in ('coach', 'athlete') then
    return query select 'invalid_role'::text, null::uuid, null::text;
    return;
  end if;

  select id into v_user_id
    from auth.users
   where lower(email) = lower(trim(p_email))
   limit 1;

  if v_user_id is null then
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  select role into v_current from public.profiles where id = v_user_id;
  if v_current is null then
    return query select 'no_profile'::text, v_user_id, null::text;
    return;
  end if;
  if v_current = 'admin' then
    return query select 'is_admin'::text, v_user_id, v_current;
    return;
  end if;

  update public.profiles set role = p_role where id = v_user_id;
  return query select 'updated'::text, v_user_id, p_role;
end;
$$;

revoke all on function public.athlevo_join_coach_by_code(text, uuid)
  from public, anon, authenticated;
revoke all on function public.athlevo_set_role_by_email(text, text)
  from public, anon, authenticated;
grant execute on function public.athlevo_join_coach_by_code(text, uuid) to service_role;
grant execute on function public.athlevo_set_role_by_email(text, text) to service_role;
