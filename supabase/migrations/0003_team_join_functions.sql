-- ============================================================================
-- LigaFam — Team creation + invite-code join/approval flow
--
-- Fixes two pre-existing gaps found while designing this feature, unrelated
-- to team-join itself but bundled here since they're in the same area:
--   1. `pending_join_requests` (0001) ran as the view owner, leaking every
--      pending request (incl. requester phone) to any authenticated user.
--      Dropped in favor of a directly-queried, RLS-correct join.
--   2. `record_score_event()` (0001) never checked the caller was an admin
--      of the game's team. Patched with the same is_team_admin() check used
--      by the new functions below.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- teams: tighten SELECT — invite_code must not be world-readable, or the
-- whole invite-code join model is pointless. Scoped to creator + members.
-- Also resolves architecture-plan.md §9 open question #3 (invite-code-only
-- discovery, no public team directory).
-- ---------------------------------------------------------------------------
drop policy "teams: authenticated read" on public.teams;

create policy "teams: members, requesters, and creator read" on public.teams
  for select using (
    created_by = auth.uid()
    or exists (
      select 1 from public.team_members tm
      where tm.team_id = teams.id and tm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- profiles: let admins see pending requesters' name/phone — the only reason
-- the leaky view existed. "profiles: teammates can view" doesn't cover this
-- since it requires both sides already approved.
-- ---------------------------------------------------------------------------
create policy "profiles: admins view pending requesters" on public.profiles
  for select using (
    exists (
      select 1 from public.team_members tm
      where tm.user_id = public.profiles.id
        and tm.status = 'pending'
        and public.is_team_admin(tm.team_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Drop the leaky view — superseded by a direct team_members+profiles query
-- from the app, which now has correct RLS on both sides.
-- ---------------------------------------------------------------------------
drop view if exists public.pending_join_requests;

-- ---------------------------------------------------------------------------
-- invite_code entropy fix: substr(md5(random()::text), 0, 8) with a 0 start
-- index actually yields 7 hex chars (~28 bits), not 8. Bump to 10.
-- ---------------------------------------------------------------------------
alter table public.teams
  alter column invite_code set default encode(gen_random_bytes(5), 'hex');

-- ---------------------------------------------------------------------------
-- Patch record_score_event(): add the missing admin check. Same signature,
-- so this is a safe create-or-replace over the 0001 definition.
-- ---------------------------------------------------------------------------
create or replace function public.record_score_event(
  p_game_id uuid,
  p_inning int,
  p_inning_half text,
  p_runs int,
  p_scoring_team text,
  p_note text default null
) returns public.games as $$
declare
  v_game public.games;
  v_team_id uuid;
begin
  select e.team_id into v_team_id
  from public.games g
  join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then
    raise exception 'GAME_NOT_FOUND';
  end if;

  if not public.is_team_admin(v_team_id) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  insert into public.game_score_events (game_id, inning, inning_half, runs_scored, scoring_team, note, created_by)
  values (p_game_id, p_inning, p_inning_half, p_runs, p_scoring_team, p_note, auth.uid());

  if p_scoring_team = 'us' then
    update public.games
      set our_score = our_score + p_runs,
          current_inning = p_inning,
          inning_half = p_inning_half,
          status = 'live'
      where id = p_game_id
      returning * into v_game;
  else
    update public.games
      set opponent_score = opponent_score + p_runs,
          current_inning = p_inning,
          inning_half = p_inning_half,
          status = 'live'
      where id = p_game_id
      returning * into v_game;
  end if;

  return v_game;
end;
$$ language plpgsql security definer;

-- ============================================================================
-- Team creation + join/approval RPCs
-- ============================================================================

-- ---------------------------------------------------------------------------
-- create_team: inserts the team and an approved admin row for the creator
-- in one transaction. The only way to become an admin today.
-- ---------------------------------------------------------------------------
create or replace function public.create_team(
  p_name text,
  p_sport text default 'baseball',
  p_age_group text default null
) returns public.teams
language plpgsql security definer set search_path = public as $$
declare
  v_team public.teams;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  insert into public.teams (name, sport, age_group, created_by)
  values (p_name, p_sport, p_age_group, auth.uid())
  returning * into v_team;

  insert into public.team_members (team_id, user_id, role, status, decided_by, decided_at)
  values (v_team.id, auth.uid(), 'admin', 'approved', auth.uid(), now());

  return v_team;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_joinable_team: minimal team lookup by invite code, for the join flow's
-- "confirm this is your team" step. Needed because teams SELECT is now
-- membership-scoped above — a pre-membership joiner can't read `teams`
-- directly.
-- ---------------------------------------------------------------------------
create or replace function public.get_joinable_team(p_invite_code text)
returns table(id uuid, name text, sport text, age_group text)
language sql security definer stable set search_path = public as $$
  select t.id, t.name, t.sport, t.age_group
  from public.teams t
  where t.invite_code = p_invite_code
    and auth.role() = 'authenticated';
$$;

-- ---------------------------------------------------------------------------
-- get_joinable_roster: minimal player list by invite code, for the family
-- join step's "select your kid" picker. Deliberately narrow columns (no
-- birth_year/team_id) — this is a genuinely new pre-approval read, not
-- equivalent to post-approval roster access.
-- ---------------------------------------------------------------------------
create or replace function public.get_joinable_roster(p_invite_code text)
returns table(player_id uuid, first_name text, last_name text, jersey_number text)
language sql security definer stable set search_path = public as $$
  select p.id, p.first_name, p.last_name, p.jersey_number
  from public.players p
  join public.teams t on t.id = p.team_id
  where t.invite_code = p_invite_code
    and auth.role() = 'authenticated';
$$;

-- ---------------------------------------------------------------------------
-- request_to_join_team: creates a pending team_members row (family or fan
-- only — admin is not self-service). For family, validates every selected
-- player belongs to this team, then materializes family_links immediately
-- (removed again on rejection — see reject_join_request). Handles re-request
-- after a prior rejection by resetting the existing row instead of hitting
-- the unique(team_id, user_id) constraint.
-- ---------------------------------------------------------------------------
create or replace function public.request_to_join_team(
  p_invite_code text,
  p_role public.team_role,
  p_player_ids uuid[] default null
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

  if p_role = 'admin' then
    raise exception 'ADMIN_NOT_ALLOWED_VIA_JOIN';
  end if;

  select id into v_team_id from public.teams where invite_code = p_invite_code;
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
-- approve_join_request / reject_join_request: both bypass RLS as
-- SECURITY DEFINER, so both do their own is_team_admin() check — this is
-- the actual authorization boundary, not the (nonexistent) RLS on this path.
-- ---------------------------------------------------------------------------
create or replace function public.approve_join_request(p_team_member_id uuid)
returns public.team_members
language plpgsql security definer set search_path = public as $$
declare
  v_row public.team_members;
  v_member public.team_members;
begin
  select * into v_row from public.team_members where id = p_team_member_id;
  if v_row.id is null then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if not public.is_team_admin(v_row.team_id) then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'REQUEST_NOT_PENDING';
  end if;

  update public.team_members
    set status = 'approved', decided_by = auth.uid(), decided_at = now()
    where id = p_team_member_id
    returning * into v_member;

  return v_member;
end;
$$;

create or replace function public.reject_join_request(p_team_member_id uuid)
returns public.team_members
language plpgsql security definer set search_path = public as $$
declare
  v_row public.team_members;
  v_member public.team_members;
begin
  select * into v_row from public.team_members where id = p_team_member_id;
  if v_row.id is null then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if not public.is_team_admin(v_row.team_id) then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'REQUEST_NOT_PENDING';
  end if;

  delete from public.family_links where team_member_id = p_team_member_id;

  update public.team_members
    set status = 'rejected', decided_by = auth.uid(), decided_at = now()
    where id = p_team_member_id
    returning * into v_member;

  return v_member;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants — defense in depth. Every function above already checks auth.uid()
-- or delegates to is_team_admin(), so these aren't the load-bearing gate,
-- but there's no reason to leave EXECUTE open to the `public` role either.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_team(text, text, text) from public;
revoke execute on function public.get_joinable_team(text) from public;
revoke execute on function public.get_joinable_roster(text) from public;
revoke execute on function public.request_to_join_team(text, public.team_role, uuid[]) from public;
revoke execute on function public.approve_join_request(uuid) from public;
revoke execute on function public.reject_join_request(uuid) from public;

grant execute on function public.create_team(text, text, text) to authenticated;
grant execute on function public.get_joinable_team(text) to authenticated;
grant execute on function public.get_joinable_roster(text) to authenticated;
grant execute on function public.request_to_join_team(text, public.team_role, uuid[]) to authenticated;
grant execute on function public.approve_join_request(uuid) to authenticated;
grant execute on function public.reject_join_request(uuid) to authenticated;
