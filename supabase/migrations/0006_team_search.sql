-- ============================================================================
-- LigaFam — Public team search/directory
--
-- Lets any authenticated user search teams by name/category to find one to
-- request joining, without needing the invite code first. Does NOT touch
-- the existing `teams` RLS policy (0003) -- invite_code and full-row access
-- stay member/creator-only exactly as before. search_teams is a narrow
-- SECURITY DEFINER surface exposing only name/sport/age_group.
-- ============================================================================

create or replace function public.search_teams(p_query text)
returns table(id uuid, name text, sport text, age_group text)
language sql security definer stable set search_path = public as $$
  select t.id, t.name, t.sport, t.age_group
  from public.teams t
  where auth.role() = 'authenticated'
    and (t.name ilike '%' || p_query || '%' or t.age_group ilike '%' || p_query || '%')
  order by t.name
  limit 25;
$$;

revoke execute on function public.search_teams(text) from public;
grant execute on function public.search_teams(text) to authenticated;

-- ---------------------------------------------------------------------------
-- request_to_join_team: add a team_id path alongside invite_code, for joins
-- originating from search. New param appended at the END with a default --
-- NOT reordered. Postgres function identity is name + ordered parameter
-- TYPES, not names or defaults -- reordering would silently create a
-- duplicate overloaded function instead of replacing the live one.
--
-- p_role gets `default null` too even though it's logically required:
-- Postgres requires every parameter after the first one with a default to
-- also have a default (a hard CREATE FUNCTION rule, independent of the
-- named-argument calling convention PostgREST always uses) -- p_invite_code
-- becoming optional forces this. Enforced instead by an explicit runtime
-- check; both real call sites always pass it, so this is unreachable in
-- practice, purely there to satisfy the declaration rule.
--
-- IMPORTANT: appending a parameter still changes the function's signature
-- (name + ordered parameter TYPES), so CREATE OR REPLACE does NOT replace
-- the original 3-arg function -- it silently creates a second, overloaded
-- one alongside it. Any caller using the old 3-arg shape (no p_team_id) then
-- becomes ambiguous between the two and fails with PGRST203. The old
-- signature must be dropped explicitly.
-- ---------------------------------------------------------------------------
drop function if exists public.request_to_join_team(text, public.team_role, uuid[]);

create or replace function public.request_to_join_team(
  p_invite_code text default null,
  p_role public.team_role default null,
  p_player_ids uuid[] default null,
  p_team_id uuid default null
) returns public.team_members
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_existing public.team_members;
  v_member public.team_members;
  v_invalid_count int;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if p_role is null then
    raise exception 'INVALID_INVITE_CODE'; -- app-bug-only path, no dedicated code needed
  end if;

  if p_role = 'admin' then
    raise exception 'ADMIN_NOT_ALLOWED_VIA_JOIN';
  end if;

  if p_team_id is not null then
    v_team_id := p_team_id;
  elsif p_invite_code is not null then
    select id into v_team_id from public.teams where invite_code = p_invite_code;
  end if;

  if v_team_id is null then
    raise exception 'INVALID_INVITE_CODE';
  end if;

  select * into v_existing from public.team_members
    where team_id = v_team_id and user_id = auth.uid();

  if v_existing.id is not null then
    if v_existing.status = 'approved' then
      raise exception 'ALREADY_MEMBER';
    elsif v_existing.status = 'pending' then
      raise exception 'REQUEST_ALREADY_PENDING';
    end if;

    update public.team_members
      set role = p_role, status = 'pending', requested_at = now(),
          decided_by = null, decided_at = null
      where id = v_existing.id
      returning * into v_member;

    delete from public.family_links where team_member_id = v_member.id;
  else
    insert into public.team_members (team_id, user_id, role, status)
    values (v_team_id, auth.uid(), p_role, 'pending')
    returning * into v_member;
  end if;

  if p_role = 'family' then
    if p_player_ids is null or array_length(p_player_ids, 1) is null then
      raise exception 'FAMILY_REQUIRES_PLAYER_SELECTION';
    end if;

    select count(*) into v_invalid_count
      from unnest(p_player_ids) pid
      where not exists (
        select 1 from public.players pl where pl.id = pid and pl.team_id = v_team_id
      );

    if v_invalid_count > 0 then
      raise exception 'INVALID_PLAYER_SELECTION';
    end if;

    insert into public.family_links (team_member_id, player_id)
    select v_member.id, pid from unnest(p_player_ids) pid
    on conflict (team_member_id, player_id) do nothing;
  end if;

  return v_member;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_joinable_roster: same team_id-alongside-invite_code treatment. Only
-- had one existing param (no default), so appending a second optional one
-- has no declaration-order issue -- but same signature-change caveat as
-- above: the old 1-arg version must be dropped explicitly, or it lingers as
-- an ambiguous overload against the new 2-arg version.
-- ---------------------------------------------------------------------------
drop function if exists public.get_joinable_roster(text);

create or replace function public.get_joinable_roster(
  p_invite_code text default null,
  p_team_id uuid default null
)
returns table(player_id uuid, first_name text, last_name text, jersey_number text)
language sql security definer stable set search_path = public as $$
  select p.id, p.first_name, p.last_name, p.jersey_number
  from public.players p
  join public.teams t on t.id = p.team_id
  where auth.role() = 'authenticated'
    and (
      (p_team_id is not null and t.id = p_team_id)
      or (p_invite_code is not null and t.invite_code = p_invite_code)
    );
$$;
