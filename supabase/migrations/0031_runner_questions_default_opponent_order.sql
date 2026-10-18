-- ============================================================================
-- LigaFam — Runner questions on hits + default opponent batting order.
--
-- 1. record_batter_hit gains an optional p_runner_dest jsonb so the scorer
--    can say where each runner actually ended up on a single/double (a
--    runner on 2nd on a double scored OR stopped at 3rd). Omitting it keeps
--    every old behavior exactly. Parameter list changes, so the old
--    (uuid, text) signature is dropped first.
-- 2. start_game seeds nine blank opponent batting-order slots (#1-#9) when
--    a game has none, and the same backfill runs here for games already in
--    progress, so the opponent's order is always tracked.
-- ============================================================================
drop function if exists public.record_batter_hit(uuid, text);

create or replace function public.record_batter_hit(p_game_id uuid, p_hit_type text, p_runner_dest jsonb default null)
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
  v_batter_dest int; v_dest1 int := 0; v_dest2 int := 0; v_dest3 int := 0;
  v_override int;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_hit_type not in ('single', 'double', 'triple', 'home_run', 'hbp') then raise exception 'INVALID_HIT_TYPE'; end if;
  if p_runner_dest is not null and jsonb_typeof(p_runner_dest) <> 'object' then raise exception 'INVALID_RUNNER_DESTINATION'; end if;

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

  -- Where each existing runner ends up: 0 = nobody there, 1-3 = that base,
  -- 4 = scores. The defaults below are exactly the old deterministic rules
  -- (0027): home run/triple send everyone home, a double sends the runners
  -- on 2nd/3rd home and the runner on 1st to 3rd, a single/hbp only moves
  -- forced runners. For singles and doubles the scorer can now override
  -- where each runner actually ended up via p_runner_dest, e.g.
  -- {"second": "third"} for a runner on 2nd who stopped at 3rd on a double.
  v_new_r1 := false; v_new_r1_id := null;
  v_new_r2 := false; v_new_r2_id := null;
  v_new_r3 := false; v_new_r3_id := null;

  if p_hit_type = 'home_run' then
    v_batter_dest := 4;
    if v_runner_on_first then v_dest1 := 4; end if;
    if v_runner_on_second then v_dest2 := 4; end if;
    if v_runner_on_third then v_dest3 := 4; end if;
  elsif p_hit_type = 'triple' then
    v_batter_dest := 3;
    if v_runner_on_first then v_dest1 := 4; end if;
    if v_runner_on_second then v_dest2 := 4; end if;
    if v_runner_on_third then v_dest3 := 4; end if;
  elsif p_hit_type = 'double' then
    v_batter_dest := 2;
    if v_runner_on_first then v_dest1 := 3; end if;
    if v_runner_on_second then v_dest2 := 4; end if;
    if v_runner_on_third then v_dest3 := 4; end if;
  else -- 'single' or 'hbp': batter forced to first, cascading only if forced.
    v_batter_dest := 1;
    if v_runner_on_first then v_dest1 := 2; end if;
    if v_runner_on_second then v_dest2 := case when v_runner_on_first then 3 else 2 end; end if;
    if v_runner_on_third then v_dest3 := case when v_runner_on_first and v_runner_on_second then 4 else 3 end; end if;
  end if;

  if p_runner_dest is not null and p_hit_type in ('single', 'double') then
    if p_runner_dest ? 'first' and v_runner_on_first then
      v_override := case p_runner_dest->>'first' when 'first' then 1 when 'second' then 2 when 'third' then 3 when 'home' then 4 else null end;
      if v_override is null then raise exception 'INVALID_RUNNER_DESTINATION'; end if;
      v_dest1 := v_override;
    end if;
    if p_runner_dest ? 'second' and v_runner_on_second then
      v_override := case p_runner_dest->>'second' when 'first' then 1 when 'second' then 2 when 'third' then 3 when 'home' then 4 else null end;
      if v_override is null then raise exception 'INVALID_RUNNER_DESTINATION'; end if;
      v_dest2 := v_override;
    end if;
    if p_runner_dest ? 'third' and v_runner_on_third then
      v_override := case p_runner_dest->>'third' when 'first' then 1 when 'second' then 2 when 'third' then 3 when 'home' then 4 else null end;
      if v_override is null then raise exception 'INVALID_RUNNER_DESTINATION'; end if;
      v_dest3 := v_override;
    end if;

    -- Each runner must reach at least the base their hit forces (a single
    -- only forces runners the batter pushes; a double clears the batter's
    -- 2nd base), never move backward, and runners keep their order.
    if v_runner_on_first and v_dest1 < (case when p_hit_type = 'single' then 2 else 3 end) then
      raise exception 'INVALID_RUNNER_DESTINATION';
    end if;
    if v_runner_on_second and v_dest2 < (case when p_hit_type = 'single' then (case when v_runner_on_first then 3 else 2 end) else 3 end) then
      raise exception 'INVALID_RUNNER_DESTINATION';
    end if;
    if v_runner_on_third and v_dest3 < (case when p_hit_type = 'single' and not (v_runner_on_first and v_runner_on_second) then 3
                                             when p_hit_type = 'single' then 4 else 3 end) then
      raise exception 'INVALID_RUNNER_DESTINATION';
    end if;
    if v_runner_on_first and v_runner_on_second and v_dest1 < 4 and v_dest2 < 4 and v_dest1 >= v_dest2 then
      raise exception 'INVALID_RUNNER_DESTINATION';
    end if;
    if v_runner_on_first and v_runner_on_third and v_dest1 < 4 and v_dest3 < 4 and v_dest1 >= v_dest3 then
      raise exception 'INVALID_RUNNER_DESTINATION';
    end if;
    if v_runner_on_second and v_runner_on_third and v_dest2 < 4 and v_dest3 < 4 and v_dest2 >= v_dest3 then
      raise exception 'INVALID_RUNNER_DESTINATION';
    end if;
  end if;

  -- Apply the destinations.
  if v_runner_on_first then
    if v_dest1 = 4 then v_scored_first := true;
    elsif v_dest1 = 1 then v_new_r1 := true; v_new_r1_id := v_runner_on_first_player_id;
    elsif v_dest1 = 2 then v_new_r2 := true; v_new_r2_id := v_runner_on_first_player_id;
    else v_new_r3 := true; v_new_r3_id := v_runner_on_first_player_id; end if;
  end if;
  if v_runner_on_second then
    if v_dest2 = 4 then v_scored_second := true;
    elsif v_dest2 = 1 then v_new_r1 := true; v_new_r1_id := v_runner_on_second_player_id;
    elsif v_dest2 = 2 then v_new_r2 := true; v_new_r2_id := v_runner_on_second_player_id;
    else v_new_r3 := true; v_new_r3_id := v_runner_on_second_player_id; end if;
  end if;
  if v_runner_on_third then
    if v_dest3 = 4 then v_scored_third := true;
    elsif v_dest3 = 1 then v_new_r1 := true; v_new_r1_id := v_runner_on_third_player_id;
    elsif v_dest3 = 2 then v_new_r2 := true; v_new_r2_id := v_runner_on_third_player_id;
    else v_new_r3 := true; v_new_r3_id := v_runner_on_third_player_id; end if;
  end if;
  if v_batter_dest = 4 then v_batter_scored := true;
  elsif v_batter_dest = 1 then v_new_r1 := true; v_new_r1_id := v_batter_id;
  elsif v_batter_dest = 2 then v_new_r2 := true; v_new_r2_id := v_batter_id;
  else v_new_r3 := true; v_new_r3_id := v_batter_id; end if;

  v_runs := (case when v_scored_first then 1 else 0 end) + (case when v_scored_second then 1 else 0 end)
          + (case when v_scored_third then 1 else 0 end) + (case when v_batter_scored then 1 else 0 end);

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

revoke execute on function public.record_batter_hit(uuid, text, jsonb) from public;
grant execute on function public.record_batter_hit(uuid, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- start_game: body-only replace (same signature) -- seeds the default
-- opponent order.
-- ---------------------------------------------------------------------------
create or replace function public.start_game(p_event_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_event_type public.event_type;
  v_game public.games;
begin
  select team_id, type into v_team_id, v_event_type from public.events where id = p_event_id;

  if v_team_id is null then raise exception 'EVENT_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_event_type <> 'game' then raise exception 'NOT_A_GAME_EVENT'; end if;

  insert into public.games (event_id, status, started_at)
  values (p_event_id, 'live', now())
  on conflict (event_id) do nothing
  returning * into v_game;

  if v_game.id is null then
    select * into v_game from public.games where event_id = p_event_id;

    if v_game.status = 'final' then
      raise exception 'GAME_ALREADY_FINAL';
    end if;

    update public.games
      set status = 'live', started_at = coalesce(started_at, now())
      where id = v_game.id
      returning * into v_game;
  end if;

  -- Every game gets a default opponent batting order of nine unnamed
  -- slots (shown as "#1".."#9") so the opponent's turn at bat is tracked
  -- from the first pitch whether or not names/numbers are ever entered.
  if not exists (select 1 from public.game_opponent_lineup where game_id = v_game.id) then
    insert into public.game_opponent_lineup (game_id, batting_order)
    select v_game.id, n from generate_series(1, 9) n;
    update public.games
      set current_opponent_batter_id = (
        select id from public.game_opponent_lineup where game_id = v_game.id order by batting_order asc limit 1
      )
      where id = v_game.id
      returning * into v_game;
  end if;

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill: games already started (not final) with no opponent order.
-- ---------------------------------------------------------------------------
insert into public.game_opponent_lineup (game_id, batting_order)
select g.id, n
from public.games g
cross join generate_series(1, 9) n
where g.status <> 'final'
  and not exists (select 1 from public.game_opponent_lineup o where o.game_id = g.id);

update public.games g
  set current_opponent_batter_id = (
    select o.id from public.game_opponent_lineup o where o.game_id = g.id order by o.batting_order asc limit 1
  )
  where g.status <> 'final' and g.current_opponent_batter_id is null
    and exists (select 1 from public.game_opponent_lineup o where o.game_id = g.id);
