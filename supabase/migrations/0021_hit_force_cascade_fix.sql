-- ============================================================================
-- LigaFam — Fix record_batter_hit: single/double/triple must force-advance
-- whoever is already standing on the landing base, not silently overwrite
-- them. This is a mandatory collision-avoidance rule (the batter and an
-- existing runner can't occupy the same base), unlike the discretionary
-- "should a runner from a base further along also advance" question --
-- which correctly stays manual (move_base_runner) per the original design.
--
-- The cascade is the same shape as the walk's force-advance in
-- record_count_event, just anchored at the hit's landing base (1st for a
-- single, 2nd for a double, 3rd for a triple) instead of always at 1st.
-- Body-only replace, same (uuid, text) signature -- found via backend
-- verification of 0020 before any real game data existed under it, so no
-- backfill is needed.
-- ============================================================================
create or replace function public.record_batter_hit(p_game_id uuid, p_hit_type text)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_half text; v_home_or_away text;
  v_current_batter uuid; v_next_batter uuid;
  v_current_opponent_batter uuid; v_next_opponent_batter uuid;
  v_runner_on_first boolean; v_runner_on_second boolean; v_runner_on_third boolean;
  v_runner_on_first_player_id uuid; v_runner_on_second_player_id uuid; v_runner_on_third_player_id uuid;
  v_our_score int; v_opponent_score int;
  v_we_are_batting boolean;
  v_runs int;
  v_batter_id uuid;
  v_new_r1 boolean; v_new_r1_id uuid;
  v_new_r2 boolean; v_new_r2_id uuid;
  v_new_r3 boolean; v_new_r3_id uuid;
  v_game public.games;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_hit_type not in ('single', 'double', 'triple', 'home_run') then raise exception 'INVALID_HIT_TYPE'; end if;

  select status, inning_half, home_or_away, current_batter_player_id, current_opponent_batter_id,
         runner_on_first, runner_on_second, runner_on_third,
         runner_on_first_player_id, runner_on_second_player_id, runner_on_third_player_id,
         our_score, opponent_score
    into v_status, v_half, v_home_or_away, v_current_batter, v_current_opponent_batter,
         v_runner_on_first, v_runner_on_second, v_runner_on_third,
         v_runner_on_first_player_id, v_runner_on_second_player_id, v_runner_on_third_player_id,
         v_our_score, v_opponent_score
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_next_batter := v_current_batter;
  v_next_opponent_batter := v_current_opponent_batter;
  v_we_are_batting := v_home_or_away is not null and (
    (v_half = 'top' and v_home_or_away = 'away') or (v_half = 'bottom' and v_home_or_away = 'home')
  );
  v_batter_id := case when v_we_are_batting then v_current_batter else null end;
  v_runs := 0;

  if p_hit_type = 'home_run' then
    -- Deterministic: batter and every occupied base all score, bases clear.
    v_runs := 1;
    if v_runner_on_first then v_runs := v_runs + 1; end if;
    if v_runner_on_second then v_runs := v_runs + 1; end if;
    if v_runner_on_third then v_runs := v_runs + 1; end if;
    v_new_r1 := false; v_new_r1_id := null;
    v_new_r2 := false; v_new_r2_id := null;
    v_new_r3 := false; v_new_r3_id := null;

  elsif p_hit_type = 'triple' then
    -- Landing base (3rd) forces anyone already there home; 1st/2nd
    -- untouched (no collision, purely discretionary -- left for
    -- move_base_runner).
    if v_runner_on_third then v_runs := v_runs + 1; end if;
    v_new_r1 := v_runner_on_first; v_new_r1_id := v_runner_on_first_player_id;
    v_new_r2 := v_runner_on_second; v_new_r2_id := v_runner_on_second_player_id;
    v_new_r3 := true; v_new_r3_id := v_batter_id;

  elsif p_hit_type = 'double' then
    -- Landing base (2nd) forces anyone there to 3rd, cascading home if 3rd
    -- was also occupied. 1st untouched.
    v_new_r1 := v_runner_on_first; v_new_r1_id := v_runner_on_first_player_id;
    if v_runner_on_second then
      if v_runner_on_third then v_runs := v_runs + 1; end if;
      v_new_r3 := true; v_new_r3_id := v_runner_on_second_player_id;
    else
      v_new_r3 := v_runner_on_third; v_new_r3_id := v_runner_on_third_player_id;
    end if;
    v_new_r2 := true; v_new_r2_id := v_batter_id;

  else -- 'single'
    -- Landing base (1st) forces anyone there to 2nd, cascading to 3rd
    -- (and home) as needed -- same shape as the walk's force cascade.
    if v_runner_on_first then
      if v_runner_on_second then
        if v_runner_on_third then v_runs := v_runs + 1; end if;
        v_new_r3 := true; v_new_r3_id := v_runner_on_second_player_id;
      else
        v_new_r3 := v_runner_on_third; v_new_r3_id := v_runner_on_third_player_id;
      end if;
      v_new_r2 := true; v_new_r2_id := v_runner_on_first_player_id;
    else
      v_new_r2 := v_runner_on_second; v_new_r2_id := v_runner_on_second_player_id;
      v_new_r3 := v_runner_on_third; v_new_r3_id := v_runner_on_third_player_id;
    end if;
    v_new_r1 := true; v_new_r1_id := v_batter_id;
  end if;

  if v_runs > 0 and v_home_or_away is not null then
    if v_we_are_batting then v_our_score := v_our_score + v_runs; else v_opponent_score := v_opponent_score + v_runs; end if;
  end if;

  if v_home_or_away is not null then
    if v_we_are_batting then
      if exists (select 1 from public.game_lineup where game_id = p_game_id) then
        v_next_batter := public.next_lineup_batter(p_game_id, v_current_batter);
      end if;
    else
      if exists (select 1 from public.game_opponent_lineup where game_id = p_game_id) then
        v_next_opponent_batter := public.next_opponent_lineup_batter(p_game_id, v_current_opponent_batter);
      end if;
    end if;
  end if;

  update public.games
    set balls = 0, strikes = 0, status = 'live',
        runner_on_first = v_new_r1, runner_on_second = v_new_r2, runner_on_third = v_new_r3,
        runner_on_first_player_id = v_new_r1_id, runner_on_second_player_id = v_new_r2_id, runner_on_third_player_id = v_new_r3_id,
        our_score = v_our_score, opponent_score = v_opponent_score,
        current_batter_player_id = v_next_batter, current_opponent_batter_id = v_next_opponent_batter
    where id = p_game_id
    returning * into v_game;

  return v_game;
end;
$$;
