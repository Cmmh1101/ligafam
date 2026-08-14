-- ============================================================================
-- LigaFam — Team public/private visibility at creation time
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Same plain-text + check-constraint pattern as events.visibility (0017)
-- and admin_invites.status -- not a real pg enum. A "private" team is
-- simply excluded from search_teams() (undiscoverable); invite-code
-- joining (get_joinable_team / request_to_join_team) is untouched --
-- neither reads any privacy signal today. Default 'public' preserves
-- today's exact behavior for every existing row.
-- ---------------------------------------------------------------------------
alter table public.teams
  add column visibility text not null default 'public'
    check (visibility in ('public', 'private'));

-- ---------------------------------------------------------------------------
-- create_team: append the new param at the end with a default, per the
-- established convention (0006/0017). Appending still changes the
-- function's identity (name + ordered parameter TYPES) -- plain CREATE
-- OR REPLACE would NOT replace the live 3-arg version, it would create
-- a second, ambiguous overload and break createTeamAction's existing
-- 3-arg RPC call with PGRST203. Drop the old signature explicitly first.
-- ---------------------------------------------------------------------------
drop function if exists public.create_team(text, text, text);

create or replace function public.create_team(
  p_name text,
  p_sport text default 'baseball',
  p_age_group text default null,
  p_visibility text default 'public'
) returns public.teams
language plpgsql security definer set search_path = public as $$
declare
  v_team public.teams;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if p_visibility not in ('public', 'private') then
    raise exception 'INVALID_VISIBILITY';
  end if;

  insert into public.teams (name, sport, age_group, visibility, created_by)
  values (p_name, p_sport, p_age_group, p_visibility, auth.uid())
  returning * into v_team;

  insert into public.team_members (team_id, user_id, role, status, decided_by, decided_at)
  values (v_team.id, auth.uid(), 'admin', 'approved', auth.uid(), now());

  return v_team;
end;
$$;

revoke execute on function public.create_team(text, text, text, text) from public;
grant execute on function public.create_team(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- search_teams: exclude private teams. Same signature as 0006 -- no
-- param change, plain CREATE OR REPLACE is safe, no drop needed.
-- ---------------------------------------------------------------------------
create or replace function public.search_teams(p_query text)
returns table(id uuid, name text, sport text, age_group text)
language sql security definer stable set search_path = public as $$
  select t.id, t.name, t.sport, t.age_group
  from public.teams t
  where auth.role() = 'authenticated'
    and t.visibility = 'public'
    and (t.name ilike '%' || p_query || '%' or t.age_group ilike '%' || p_query || '%')
  order by t.name
  limit 25;
$$;
