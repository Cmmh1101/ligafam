-- ============================================================================
-- LigaFam — Defensive positions: constrain the two already-existing-but-
-- unused position columns now that the app actually writes to them, and add
-- a small dedicated RPC to set a lineup slot's position (same
-- one-independent-field pattern as set_current_pitcher/set_current_batter).
-- ============================================================================

alter table public.players add constraint players_primary_position_check
  check (primary_position is null or primary_position in ('P','C','1B','2B','3B','SS','LF','CF','RF'));

alter table public.game_lineup add constraint game_lineup_position_check
  check (position is null or position in ('P','C','1B','2B','3B','SS','LF','CF','RF'));

-- ---------------------------------------------------------------------------
-- set_lineup_position: independent, immediate, single-field write --
-- validates the player is actually in this game's lineup (unlike
-- set_current_pitcher, which allows anyone on the roster).
-- ---------------------------------------------------------------------------
create or replace function public.set_lineup_position(
  p_game_id uuid, p_player_id uuid, p_position text
) returns public.game_lineup
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_row public.game_lineup;
begin
  select e.team_id, g.status into v_team_id, v_status
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;
  if p_position is not null and p_position not in ('P','C','1B','2B','3B','SS','LF','CF','RF') then
    raise exception 'INVALID_POSITION';
  end if;

  update public.game_lineup set position = p_position
  where game_id = p_game_id and player_id = p_player_id
  returning * into v_row;

  if v_row.id is null then raise exception 'PLAYER_NOT_IN_LINEUP'; end if;
  return v_row;
end;
$$;

revoke execute on function public.set_lineup_position(uuid, uuid, text) from public;
grant execute on function public.set_lineup_position(uuid, uuid, text) to authenticated;
