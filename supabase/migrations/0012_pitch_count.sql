alter table public.games
  add column our_pitcher_pitch_count int not null default 0,
  add column opponent_pitcher_pitch_count int not null default 0,
  add column last_pitch_charged_to text check (last_pitch_charged_to in ('our', 'opponent'));

-- record_count_event: body-only replace, same (uuid, text, int) signature.
-- Attributes every ball/strike (not "out") to whichever side is pitching
-- this half, using the same boolean the existing batter-advance logic
-- already computes. Stores last_pitch_charged_to at increment time so a
-- later -1 correction undoes the SAME side even if the half has since
-- flipped -- e.g. correcting a backwards-K that was also the 3rd out:
-- recomputing "who's pitching" from live state on the -1 path would
-- silently charge the wrong side once the half has moved on.
create or replace function public.record_count_event(
  p_game_id uuid, p_event_type text, p_delta int default 1
) returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_game public.games;
  v_team_id uuid;
  v_balls int; v_strikes int; v_outs int; v_inning int; v_half text; v_half_at_pa_start text;
  v_status public.game_status; v_home_or_away text;
  v_current_batter uuid; v_next_batter uuid;
  v_current_opponent_batter uuid; v_next_opponent_batter uuid;
  v_our_pitch_count int; v_opponent_pitch_count int; v_last_pitch_charged_to text;
  v_pa_ended boolean := false;
  v_we_are_batting boolean;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_event_type not in ('ball', 'strike', 'out') then raise exception 'INVALID_COUNT_EVENT'; end if;
  if p_delta is distinct from 1 and p_delta is distinct from -1 then raise exception 'INVALID_COUNT_DELTA'; end if;

  select balls, strikes, outs, current_inning, inning_half, status, home_or_away,
         current_batter_player_id, current_opponent_batter_id,
         our_pitcher_pitch_count, opponent_pitcher_pitch_count, last_pitch_charged_to
    into v_balls, v_strikes, v_outs, v_inning, v_half, v_status, v_home_or_away,
         v_current_batter, v_current_opponent_batter,
         v_our_pitch_count, v_opponent_pitch_count, v_last_pitch_charged_to
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_half_at_pa_start := v_half;
  v_next_batter := v_current_batter;
  v_next_opponent_batter := v_current_opponent_batter;

  v_we_are_batting := v_home_or_away is not null and (
    (v_half_at_pa_start = 'top' and v_home_or_away = 'away') or (v_half_at_pa_start = 'bottom' and v_home_or_away = 'home')
  );

  if p_event_type in ('ball', 'strike') then
    if p_delta = 1 then
      if v_home_or_away is not null then
        if v_we_are_batting then
          v_opponent_pitch_count := v_opponent_pitch_count + 1;
          v_last_pitch_charged_to := 'opponent';
        else
          v_our_pitch_count := v_our_pitch_count + 1;
          v_last_pitch_charged_to := 'our';
        end if;
      end if;
    else
      if v_last_pitch_charged_to = 'opponent' then
        v_opponent_pitch_count := greatest(v_opponent_pitch_count - 1, 0);
      elsif v_last_pitch_charged_to = 'our' then
        v_our_pitch_count := greatest(v_our_pitch_count - 1, 0);
      end if;
      v_last_pitch_charged_to := null;
    end if;
  end if;

  if p_delta = 1 then
    if p_event_type = 'ball' then
      v_balls := v_balls + 1;
      if v_balls >= 4 then v_balls := 0; v_strikes := 0; v_pa_ended := true; end if;
    elsif p_event_type = 'strike' then
      v_strikes := v_strikes + 1;
      if v_strikes >= 3 then v_strikes := 0; v_balls := 0; v_outs := v_outs + 1; v_pa_ended := true; end if;
    else
      v_balls := 0; v_strikes := 0; v_outs := v_outs + 1; v_pa_ended := true;
    end if;

    if v_outs >= 3 then
      v_outs := 0;
      if v_half = 'top' then v_half := 'bottom'; else v_half := 'top'; v_inning := v_inning + 1; end if;
    end if;

    if v_pa_ended and v_home_or_away is not null then
      if (v_half_at_pa_start = 'top' and v_home_or_away = 'away') or (v_half_at_pa_start = 'bottom' and v_home_or_away = 'home') then
        if exists (select 1 from public.game_lineup where game_id = p_game_id) then
          v_next_batter := public.next_lineup_batter(p_game_id, v_current_batter);
        end if;
      else
        if exists (select 1 from public.game_opponent_lineup where game_id = p_game_id) then
          v_next_opponent_batter := public.next_opponent_lineup_batter(p_game_id, v_current_opponent_batter);
        end if;
      end if;
    end if;
  else
    if p_event_type = 'ball' then v_balls := greatest(v_balls - 1, 0);
    elsif p_event_type = 'strike' then v_strikes := greatest(v_strikes - 1, 0);
    else v_outs := greatest(v_outs - 1, 0);
    end if;
  end if;

  update public.games
    set balls = v_balls, strikes = v_strikes, outs = v_outs, current_inning = v_inning, inning_half = v_half,
        status = 'live', current_batter_player_id = v_next_batter, current_opponent_batter_id = v_next_opponent_batter,
        our_pitcher_pitch_count = v_our_pitch_count, opponent_pitcher_pitch_count = v_opponent_pitch_count,
        last_pitch_charged_to = v_last_pitch_charged_to
    where id = p_game_id
    returning * into v_game;

  return v_game;
end;
$$;

-- set_current_pitcher: body-only replace, same (uuid, uuid) signature.
-- Resets OUR pitch count whenever our pitcher is (re)assigned.
create or replace function public.set_current_pitcher(p_game_id uuid, p_player_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid; v_status public.game_status; v_game public.games;
begin
  select e.team_id, g.status into v_team_id, v_status from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;
  if p_player_id is not null and not exists (select 1 from public.players where id = p_player_id and team_id = v_team_id) then
    raise exception 'INVALID_PLAYER_SELECTION';
  end if;

  update public.games set current_pitcher_player_id = p_player_id, our_pitcher_pitch_count = 0
    where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

-- set_opponent_pitcher: body-only replace, same (uuid, text, text) signature.
-- Only resets the count when the name/number actually changed, not on
-- every save -- a typo fix shouldn't silently zero a live pitch count.
create or replace function public.set_opponent_pitcher(p_game_id uuid, p_name text, p_number text)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid; v_status public.game_status;
  v_current_name text; v_current_number text; v_new_name text; v_new_number text;
  v_game public.games;
begin
  select e.team_id, g.status, g.opponent_pitcher_name, g.opponent_pitcher_number
    into v_team_id, v_status, v_current_name, v_current_number
  from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_new_name := nullif(trim(p_name), '');
  v_new_number := nullif(trim(p_number), '');

  update public.games
    set opponent_pitcher_name = v_new_name, opponent_pitcher_number = v_new_number,
        opponent_pitcher_pitch_count = case
          when v_new_name is distinct from v_current_name or v_new_number is distinct from v_current_number
          then 0 else opponent_pitcher_pitch_count end
    where id = p_game_id
    returning * into v_game;
  return v_game;
end;
$$;
