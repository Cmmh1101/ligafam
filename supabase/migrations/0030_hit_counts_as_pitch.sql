-- ============================================================================
-- LigaFam — Count hits (and hit-by-pitch) as a pitch.
--
-- record_batter_hit never touched the pitch count, so every single/double/
-- triple/home run/HBP left the pitcher's count one short. Body-only replace
-- of 0028's version, same (uuid, text) signature; the only change is the
-- pitch-count attribution block and the three extra columns read/written.
-- ============================================================================
create or replace function public.record_batter_hit(p_game_id uuid, p_hit_type text)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_half text; v_home_or_away text; v_inning int;
  v_current_batter uuid; v_next_batter uuid;
  v_current_opponent_batter uuid; v_next_opponent_batter uuid;
  v_current_pitcher uuid;
  v_runner_on_first boolean; v_runner_on_second boolean; v_runner_on_third boolean;
  v_runner_on_first_player_id uuid; v_runner_on_second_player_id uuid; v_runner_on_third_player_id uuid;
  v_our_score int; v_opponent_score int;
  v_we_are_batting boolean;
  v_runs int;
  v_batter_id uuid;
  v_new_r1 boolean; v_new_r1_id uuid;
  v_new_r2 boolean; v_new_r2_id uuid;
  v_new_r3 boolean; v_new_r3_id uuid;
  v_scored_first boolean := false; v_scored_second boolean := false; v_scored_third boolean := false;
  v_batter_scored boolean := false;
  v_pa_id uuid;
  v_i int;
  v_game public.games;
  v_games_snapshot jsonb;
  v_run_id uuid;
  v_runs_scored_ids uuid[] := '{}';
  v_our_pitch_count int; v_opponent_pitch_count int; v_last_pitch_charged_to text;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_hit_type not in ('single', 'double', 'triple', 'home_run', 'hbp') then raise exception 'INVALID_HIT_TYPE'; end if;

  select status, current_inning, inning_half, home_or_away, current_batter_player_id, current_opponent_batter_id,
         current_pitcher_player_id,
         runner_on_first, runner_on_second, runner_on_third,
         runner_on_first_player_id, runner_on_second_player_id, runner_on_third_player_id,
         our_score, opponent_score,
         our_pitcher_pitch_count, opponent_pitcher_pitch_count, last_pitch_charged_to
    into v_status, v_inning, v_half, v_home_or_away, v_current_batter, v_current_opponent_batter,
         v_current_pitcher,
         v_runner_on_first, v_runner_on_second, v_runner_on_third,
         v_runner_on_first_player_id, v_runner_on_second_player_id, v_runner_on_third_player_id,
         v_our_score, v_opponent_score,
         v_our_pitch_count, v_opponent_pitch_count, v_last_pitch_charged_to
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  select to_jsonb(g) into v_games_snapshot from public.games g where g.id = p_game_id;

  v_next_batter := v_current_batter;
  v_next_opponent_batter := v_current_opponent_batter;
  v_we_are_batting := v_home_or_away is not null and (
    (v_half = 'top' and v_home_or_away = 'away') or (v_half = 'bottom' and v_home_or_away = 'home')
  );
  v_batter_id := case when v_we_are_batting then v_current_batter else null end;
  v_runs := 0;

  -- A ball put in play (or a hit batter) is a pitch thrown: charge it to
  -- whichever pitcher is on the mound, same attribution record_count_event
  -- uses for ball/strike/foul, so last_pitch_charged_to (and undo) stay
  -- consistent.
  if v_home_or_away is not null then
    if v_we_are_batting then
      v_opponent_pitch_count := v_opponent_pitch_count + 1;
      v_last_pitch_charged_to := 'opponent';
    else
      v_our_pitch_count := v_our_pitch_count + 1;
      v_last_pitch_charged_to := 'our';
    end if;
  end if;

  if p_hit_type = 'home_run' then
    v_runs := 1; v_batter_scored := true;
    if v_runner_on_first then v_runs := v_runs + 1; v_scored_first := true; end if;
    if v_runner_on_second then v_runs := v_runs + 1; v_scored_second := true; end if;
    if v_runner_on_third then v_runs := v_runs + 1; v_scored_third := true; end if;
    v_new_r1 := false; v_new_r1_id := null;
    v_new_r2 := false; v_new_r2_id := null;
    v_new_r3 := false; v_new_r3_id := null;

  elsif p_hit_type = 'triple' then
    if v_runner_on_first then v_runs := v_runs + 1; v_scored_first := true; end if;
    if v_runner_on_second then v_runs := v_runs + 1; v_scored_second := true; end if;
    if v_runner_on_third then v_runs := v_runs + 1; v_scored_third := true; end if;
    v_new_r1 := false; v_new_r1_id := null;
    v_new_r2 := false; v_new_r2_id := null;
    v_new_r3 := true; v_new_r3_id := v_batter_id;

  elsif p_hit_type = 'double' then
    if v_runner_on_second then v_runs := v_runs + 1; v_scored_second := true; end if;
    if v_runner_on_third then v_runs := v_runs + 1; v_scored_third := true; end if;
    v_new_r1 := false; v_new_r1_id := null;
    v_new_r2 := true; v_new_r2_id := v_batter_id;
    v_new_r3 := v_runner_on_first; v_new_r3_id := v_runner_on_first_player_id;

  else -- 'single' or 'hbp': batter forced to first, cascading only if forced.
    if v_runner_on_first then
      if v_runner_on_second then
        if v_runner_on_third then v_runs := v_runs + 1; v_scored_third := true; end if;
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
        current_batter_player_id = v_next_batter, current_opponent_batter_id = v_next_opponent_batter,
        our_pitcher_pitch_count = v_our_pitch_count, opponent_pitcher_pitch_count = v_opponent_pitch_count,
        last_pitch_charged_to = v_last_pitch_charged_to
    where id = p_game_id
    returning * into v_game;

  insert into public.game_plate_appearances (
    game_id, side, batter_player_id, pitcher_player_id, outcome, rbi, inning, inning_half, created_by
  ) values (
    p_game_id,
    case when v_we_are_batting then 'our' else 'opponent' end,
    v_batter_id,
    case when not v_we_are_batting then v_current_pitcher else null end,
    p_hit_type, v_runs, v_inning, v_half, auth.uid()
  ) returning id into v_pa_id;

  if v_runs > 0 then
    if v_we_are_batting then
      if v_scored_first then
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, scorer_player_id)
        values (p_game_id, v_pa_id, 'our', v_runner_on_first_player_id)
        returning id into v_run_id;
        v_runs_scored_ids := v_runs_scored_ids || v_run_id;
      end if;
      if v_scored_second then
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, scorer_player_id)
        values (p_game_id, v_pa_id, 'our', v_runner_on_second_player_id)
        returning id into v_run_id;
        v_runs_scored_ids := v_runs_scored_ids || v_run_id;
      end if;
      if v_scored_third then
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, scorer_player_id)
        values (p_game_id, v_pa_id, 'our', v_runner_on_third_player_id)
        returning id into v_run_id;
        v_runs_scored_ids := v_runs_scored_ids || v_run_id;
      end if;
      if v_batter_scored then
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, scorer_player_id)
        values (p_game_id, v_pa_id, 'our', v_batter_id)
        returning id into v_run_id;
        v_runs_scored_ids := v_runs_scored_ids || v_run_id;
      end if;
    else
      for v_i in 1..v_runs loop
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, credited_pitcher_id)
        values (p_game_id, v_pa_id, 'opponent', v_current_pitcher)
        returning id into v_run_id;
        v_runs_scored_ids := v_runs_scored_ids || v_run_id;
      end loop;
    end if;
  end if;

  insert into public.game_undo_state (
    game_id, action, games_snapshot, plate_appearance_ids, runs_scored_ids
  ) values (
    p_game_id, 'batter_hit', v_games_snapshot, array[v_pa_id], v_runs_scored_ids
  )
  on conflict (game_id) do update set
    action = excluded.action, games_snapshot = excluded.games_snapshot,
    lineup_row_id = null, lineup_prior_player_id = null,
    plate_appearance_ids = excluded.plate_appearance_ids,
    runs_scored_ids = excluded.runs_scored_ids,
    runner_advance_ids = '{}', created_at = now();

  return v_game;
end;
$$;
