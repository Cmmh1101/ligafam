alter table public.games
  add column runner_on_first boolean not null default false,
  add column runner_on_second boolean not null default false,
  add column runner_on_third boolean not null default false;

-- set_base_runner: explicit set (not toggle) so a double-tap/retry is
-- idempotent -- the client always sends the exact target state it wants
-- (computed from its own last realtime-synced value), rather than the
-- server blindly flipping a bit that could double-flip and land wrong.
create or replace function public.set_base_runner(p_game_id uuid, p_base text, p_occupied boolean)
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
  if p_base not in ('first', 'second', 'third') then raise exception 'INVALID_BASE'; end if;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  if p_base = 'first' then
    update public.games set runner_on_first = p_occupied where id = p_game_id returning * into v_game;
  elsif p_base = 'second' then
    update public.games set runner_on_second = p_occupied where id = p_game_id returning * into v_game;
  else
    update public.games set runner_on_third = p_occupied where id = p_game_id returning * into v_game;
  end if;

  return v_game;
end;
$$;

revoke execute on function public.set_base_runner(uuid, text, boolean) from public;
grant execute on function public.set_base_runner(uuid, text, boolean) to authenticated;

-- record_count_event: body-only replace, same (uuid, text, int) signature.
-- Adds runner_on_first/second/third: cleared to false only on the 3rd
-- out (inning-ending) branch that already resets outs/flips the half --
-- 1st/2nd outs must NOT clear bases. Everything else is unchanged from
-- 0012_pitch_count.sql.
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
  v_runner_on_first boolean; v_runner_on_second boolean; v_runner_on_third boolean;
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
         our_pitcher_pitch_count, opponent_pitcher_pitch_count, last_pitch_charged_to,
         runner_on_first, runner_on_second, runner_on_third
    into v_balls, v_strikes, v_outs, v_inning, v_half, v_status, v_home_or_away,
         v_current_batter, v_current_opponent_batter,
         v_our_pitch_count, v_opponent_pitch_count, v_last_pitch_charged_to,
         v_runner_on_first, v_runner_on_second, v_runner_on_third
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
      v_runner_on_first := false;
      v_runner_on_second := false;
      v_runner_on_third := false;
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
        last_pitch_charged_to = v_last_pitch_charged_to,
        runner_on_first = v_runner_on_first, runner_on_second = v_runner_on_second, runner_on_third = v_runner_on_third
    where id = p_game_id
    returning * into v_game;

  return v_game;
end;
$$;
