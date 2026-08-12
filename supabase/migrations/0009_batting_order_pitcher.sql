-- ============================================================================
-- LigaFam — Batting order + current pitcher on the scoreboard
--
-- Surfaces who's currently batting and who's pitching. Reuses the existing
-- (previously unused) game_lineup table for the batting order; field
-- position assignment stays deferred. Auto-advances the current batter on
-- a plate-appearance-ending walk/strikeout, gated by a new home/away flag
-- so it only fires during OUR half of the inning -- without that gate an
-- out against the opponent's batter would silently cycle our own lineup.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. New columns + a light constraint tightening on game_lineup.batting_order
-- (table has zero rows in production today, so this is safe).
-- ---------------------------------------------------------------------------
alter table public.games
  add column current_batter_player_id uuid references public.players(id) on delete set null,
  add column current_pitcher_player_id uuid references public.players(id) on delete set null;

alter table public.game_lineup
  alter column batting_order set not null,
  add constraint game_lineup_batting_order_positive check (batting_order > 0);

-- ---------------------------------------------------------------------------
-- 2. Close the direct-write gap on game_lineup (same rationale as games in
-- 0007) -- force all lineup writes through set_lineup below.
-- ---------------------------------------------------------------------------
drop policy "game_lineup: admins write" on public.game_lineup;

-- ---------------------------------------------------------------------------
-- 3. Internal helper -- cyclic "next batter after X." Explicitly locked
-- down since it's SECURITY DEFINER and returns real row data (batting
-- order), unlike the boolean-only helpers like is_team_admin. Only ever
-- called from within other SECURITY DEFINER functions owned by the same
-- role (which always have implicit rights to call functions they own) --
-- never meant to be reachable directly as a client RPC.
-- ---------------------------------------------------------------------------
create or replace function public.next_lineup_batter(p_game_id uuid, p_current_player_id uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (
      select player_id from public.game_lineup
      where game_id = p_game_id
        and batting_order > (
          select batting_order from public.game_lineup
          where game_id = p_game_id and player_id = p_current_player_id
        )
      order by batting_order asc
      limit 1
    ),
    (select player_id from public.game_lineup where game_id = p_game_id order by batting_order asc limit 1)
  );
$$;

revoke execute on function public.next_lineup_batter(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 4. advance_batter: manual "next batter" override.
-- ---------------------------------------------------------------------------
create or replace function public.advance_batter(p_game_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_current uuid;
  v_next uuid;
  v_status public.game_status;
  v_game public.games;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  if not exists (select 1 from public.game_lineup where game_id = p_game_id) then
    raise exception 'LINEUP_EMPTY';
  end if;

  select current_batter_player_id, status into v_current, v_status
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_next := public.next_lineup_batter(p_game_id, v_current);

  update public.games set current_batter_player_id = v_next where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

revoke execute on function public.advance_batter(uuid) from public;
grant execute on function public.advance_batter(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. set_lineup: replace the whole batting order. Locks games FIRST,
-- before any game_lineup write -- without this, two concurrent set_lineup
-- calls can each delete-then-insert past each other's uncommitted state
-- and leave duplicate/overlapping batting_order rows behind.
-- ---------------------------------------------------------------------------
create or replace function public.set_lineup(p_game_id uuid, p_player_ids uuid[])
returns setof public.game_lineup
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_invalid_count int;
  v_distinct_count int;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  if p_player_ids is null or array_length(p_player_ids, 1) is null then
    raise exception 'LINEUP_REQUIRES_PLAYERS';
  end if;

  select count(*) into v_invalid_count
    from unnest(p_player_ids) pid
    where not exists (select 1 from public.players pl where pl.id = pid and pl.team_id = v_team_id);
  if v_invalid_count > 0 then raise exception 'INVALID_PLAYER_SELECTION'; end if;

  select count(distinct pid) into v_distinct_count from unnest(p_player_ids) pid;
  if v_distinct_count <> array_length(p_player_ids, 1) then raise exception 'INVALID_PLAYER_SELECTION'; end if;

  select status into v_status from public.games where id = p_game_id for update;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  delete from public.game_lineup where game_id = p_game_id;

  insert into public.game_lineup (game_id, player_id, batting_order)
  select p_game_id, pid, ord
  from unnest(p_player_ids) with ordinality as t(pid, ord);

  update public.games set current_batter_player_id = p_player_ids[1] where id = p_game_id;

  return query select * from public.game_lineup where game_id = p_game_id order by batting_order;
end;
$$;

revoke execute on function public.set_lineup(uuid, uuid[]) from public;
grant execute on function public.set_lineup(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. set_current_pitcher / 7. set_home_or_away: simple single-column
-- setters, no lineup-style corruption risk so no lock needed.
-- ---------------------------------------------------------------------------
create or replace function public.set_current_pitcher(p_game_id uuid, p_player_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_game public.games;
begin
  select e.team_id, g.status into v_team_id, v_status
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  if p_player_id is not null and not exists (select 1 from public.players where id = p_player_id and team_id = v_team_id) then
    raise exception 'INVALID_PLAYER_SELECTION';
  end if;

  update public.games set current_pitcher_player_id = p_player_id where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

revoke execute on function public.set_current_pitcher(uuid, uuid) from public;
grant execute on function public.set_current_pitcher(uuid, uuid) to authenticated;

create or replace function public.set_home_or_away(p_game_id uuid, p_home_or_away text)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_game public.games;
begin
  select e.team_id, g.status into v_team_id, v_status
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;
  if p_home_or_away not in ('home', 'away') then raise exception 'INVALID_HOME_OR_AWAY'; end if;

  update public.games set home_or_away = p_home_or_away where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

revoke execute on function public.set_home_or_away(uuid, text) from public;
grant execute on function public.set_home_or_away(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. record_count_event: body-only change (same (uuid, text, int)
-- signature, plain CREATE OR REPLACE, no drop needed). Auto-advances the
-- batter on a plate-appearance-ending walk or out, but ONLY when the PA
-- happened during OUR half of the inning.
-- ---------------------------------------------------------------------------
create or replace function public.record_count_event(
  p_game_id uuid,
  p_event_type text,
  p_delta int default 1
) returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_game public.games;
  v_team_id uuid;
  v_balls int;
  v_strikes int;
  v_outs int;
  v_inning int;
  v_half text;
  v_half_at_pa_start text;
  v_status public.game_status;
  v_home_or_away text;
  v_current_batter uuid;
  v_next_batter uuid;
  v_pa_ended boolean := false;
begin
  select e.team_id into v_team_id
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_event_type not in ('ball', 'strike', 'out') then raise exception 'INVALID_COUNT_EVENT'; end if;
  if p_delta is distinct from 1 and p_delta is distinct from -1 then
    raise exception 'INVALID_COUNT_DELTA';
  end if;

  select balls, strikes, outs, current_inning, inning_half, status, home_or_away, current_batter_player_id
    into v_balls, v_strikes, v_outs, v_inning, v_half, v_status, v_home_or_away, v_current_batter
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_half_at_pa_start := v_half;
  v_next_batter := v_current_batter;

  if p_delta = 1 then
    if p_event_type = 'ball' then
      v_balls := v_balls + 1;
      if v_balls >= 4 then v_balls := 0; v_strikes := 0; v_pa_ended := true; end if;
    elsif p_event_type = 'strike' then
      v_strikes := v_strikes + 1;
      if v_strikes >= 3 then v_strikes := 0; v_balls := 0; v_outs := v_outs + 1; v_pa_ended := true; end if;
    else -- 'out'
      v_balls := 0; v_strikes := 0; v_outs := v_outs + 1; v_pa_ended := true;
    end if;

    if v_outs >= 3 then
      v_outs := 0;
      if v_half = 'top' then v_half := 'bottom';
      else v_half := 'top'; v_inning := v_inning + 1;
      end if;
    end if;

    -- Auto-advance only for a PA that ended during OUR half of the inning
    -- (home bats in the bottom half, away bats in the top half) -- using
    -- v_half_at_pa_start (captured before the outs>=3 flip above) so a
    -- 3rd-out PA is correctly attributed to the half it happened in, not
    -- the half it flips into. If home_or_away hasn't been set yet, this
    -- condition is simply never true and auto-advance never fires -- the
    -- manual "next batter" button still works regardless.
    if v_pa_ended
       and exists (select 1 from public.game_lineup where game_id = p_game_id)
       and v_home_or_away is not null
       and (
         (v_half_at_pa_start = 'top' and v_home_or_away = 'away')
         or (v_half_at_pa_start = 'bottom' and v_home_or_away = 'home')
       )
    then
      v_next_batter := public.next_lineup_batter(p_game_id, v_current_batter);
    end if;
  else -- p_delta = -1: plain correction, no threshold side effects, no batter change
    if p_event_type = 'ball' then v_balls := greatest(v_balls - 1, 0);
    elsif p_event_type = 'strike' then v_strikes := greatest(v_strikes - 1, 0);
    else v_outs := greatest(v_outs - 1, 0);
    end if;
  end if;

  update public.games
    set balls = v_balls, strikes = v_strikes, outs = v_outs,
        current_inning = v_inning, inning_half = v_half, status = 'live',
        current_batter_player_id = v_next_batter
    where id = p_game_id
    returning * into v_game;

  return v_game;
end;
$$;
