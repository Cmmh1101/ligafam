-- ============================================================================
-- LigaFam — Accurate foul-ball pitch counting.
--
-- Once a batter has 2 strikes, a foul ball can't be logged as "+1 Strike"
-- today without wrongly ending the at-bat as a strikeout -- so those
-- pitches have gone untracked, undercounting the pitcher's real pitch
-- count. record_count_event: body-only replace, same (uuid, text, int)
-- signature. Only change from 0022's version: 'foul' added to the allowed
-- p_event_type list, folded into the (already type-agnostic) pitch-count
-- charge/reverse gate, and a new branch in both delta directions before
-- the existing catch-all 'out' else. A foul only increments strikes when
-- below 2, and never ends the plate appearance on its own (the real
-- foul-bunt-with-2-strikes-is-an-out exception isn't modeled, matching how
-- this schema already scopes out other rare-rule edge cases).
-- ============================================================================
create or replace function public.record_count_event(
  p_game_id uuid, p_event_type text, p_delta int default 1
) returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_game public.games;
  v_team_id uuid;
  v_balls int; v_strikes int; v_outs int; v_inning int; v_half text; v_half_at_pa_start text;
  v_inning_at_pa_start int;
  v_status public.game_status; v_home_or_away text;
  v_current_batter uuid; v_next_batter uuid;
  v_current_opponent_batter uuid; v_next_opponent_batter uuid;
  v_current_pitcher uuid;
  v_our_pitch_count int; v_opponent_pitch_count int; v_last_pitch_charged_to text;
  v_runner_on_first boolean; v_runner_on_second boolean; v_runner_on_third boolean;
  v_runner_on_first_player_id uuid; v_runner_on_second_player_id uuid; v_runner_on_third_player_id uuid;
  v_our_score int; v_opponent_score int;
  v_run_scored boolean;
  v_scorer_player_id uuid;
  v_pa_ended boolean := false;
  v_we_are_batting boolean;
  v_outcome text;
  v_rbi int := 0;
  v_pa_id uuid;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_event_type not in ('ball', 'strike', 'out', 'foul') then raise exception 'INVALID_COUNT_EVENT'; end if;
  if p_delta is distinct from 1 and p_delta is distinct from -1 then raise exception 'INVALID_COUNT_DELTA'; end if;

  select balls, strikes, outs, current_inning, inning_half, status, home_or_away,
         current_batter_player_id, current_opponent_batter_id, current_pitcher_player_id,
         our_pitcher_pitch_count, opponent_pitcher_pitch_count, last_pitch_charged_to,
         runner_on_first, runner_on_second, runner_on_third,
         runner_on_first_player_id, runner_on_second_player_id, runner_on_third_player_id,
         our_score, opponent_score
    into v_balls, v_strikes, v_outs, v_inning, v_half, v_status, v_home_or_away,
         v_current_batter, v_current_opponent_batter, v_current_pitcher,
         v_our_pitch_count, v_opponent_pitch_count, v_last_pitch_charged_to,
         v_runner_on_first, v_runner_on_second, v_runner_on_third,
         v_runner_on_first_player_id, v_runner_on_second_player_id, v_runner_on_third_player_id,
         v_our_score, v_opponent_score
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_half_at_pa_start := v_half;
  v_inning_at_pa_start := v_inning;
  v_next_batter := v_current_batter;
  v_next_opponent_batter := v_current_opponent_batter;

  v_we_are_batting := v_home_or_away is not null and (
    (v_half_at_pa_start = 'top' and v_home_or_away = 'away') or (v_half_at_pa_start = 'bottom' and v_home_or_away = 'home')
  );

  if p_event_type in ('ball', 'strike', 'foul') then
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
      if v_balls >= 4 then
        v_balls := 0; v_strikes := 0; v_pa_ended := true; v_outcome := 'walk';

        -- Captured before the identity cascade below overwrites it --
        -- this is who was on 3rd (if anyone) when the walk happened, i.e.
        -- the player who'd be forced home on a bases-loaded walk.
        v_scorer_player_id := v_runner_on_third_player_id;

        if v_we_are_batting then
          if v_runner_on_first and v_runner_on_second then
            v_runner_on_third_player_id := v_runner_on_second_player_id;
          end if;
          if v_runner_on_first then
            v_runner_on_second_player_id := v_runner_on_first_player_id;
          end if;
          v_runner_on_first_player_id := v_current_batter;
        else
          v_runner_on_first_player_id := null;
          v_runner_on_second_player_id := null;
          v_runner_on_third_player_id := null;
        end if;

        v_run_scored := v_runner_on_first and v_runner_on_second and v_runner_on_third;
        v_runner_on_third := (v_runner_on_first and v_runner_on_second) or v_runner_on_third;
        v_runner_on_second := v_runner_on_first or v_runner_on_second;
        v_runner_on_first := true;

        if v_run_scored and v_home_or_away is not null then
          v_rbi := 1;
          if v_we_are_batting then v_our_score := v_our_score + 1; else v_opponent_score := v_opponent_score + 1; end if;
        end if;
      end if;
    elsif p_event_type = 'strike' then
      v_strikes := v_strikes + 1;
      if v_strikes >= 3 then
        v_strikes := 0; v_balls := 0; v_outs := v_outs + 1; v_pa_ended := true; v_outcome := 'strikeout';
      end if;
    elsif p_event_type = 'foul' then
      if v_strikes < 2 then
        v_strikes := v_strikes + 1;
      end if;
    else
      v_balls := 0; v_strikes := 0; v_outs := v_outs + 1; v_pa_ended := true; v_outcome := 'out';
    end if;

    if v_outs >= 3 then
      v_outs := 0;
      if v_half = 'top' then v_half := 'bottom'; else v_half := 'top'; v_inning := v_inning + 1; end if;
      v_runner_on_first := false; v_runner_on_second := false; v_runner_on_third := false;
      v_runner_on_first_player_id := null; v_runner_on_second_player_id := null; v_runner_on_third_player_id := null;
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
    elsif p_event_type = 'foul' then v_strikes := greatest(v_strikes - 1, 0);
    else v_outs := greatest(v_outs - 1, 0);
    end if;
  end if;

  update public.games
    set balls = v_balls, strikes = v_strikes, outs = v_outs, current_inning = v_inning, inning_half = v_half,
        status = 'live', current_batter_player_id = v_next_batter, current_opponent_batter_id = v_next_opponent_batter,
        our_pitcher_pitch_count = v_our_pitch_count, opponent_pitcher_pitch_count = v_opponent_pitch_count,
        last_pitch_charged_to = v_last_pitch_charged_to,
        runner_on_first = v_runner_on_first, runner_on_second = v_runner_on_second, runner_on_third = v_runner_on_third,
        runner_on_first_player_id = v_runner_on_first_player_id,
        runner_on_second_player_id = v_runner_on_second_player_id,
        runner_on_third_player_id = v_runner_on_third_player_id,
        our_score = v_our_score, opponent_score = v_opponent_score
    where id = p_game_id
    returning * into v_game;

  if v_pa_ended and v_outcome is not null then
    insert into public.game_plate_appearances (
      game_id, side, batter_player_id, pitcher_player_id, outcome, rbi, inning, inning_half, created_by
    ) values (
      p_game_id,
      case when v_we_are_batting then 'our' else 'opponent' end,
      case when v_we_are_batting then v_current_batter else null end,
      case when not v_we_are_batting then v_current_pitcher else null end,
      v_outcome, v_rbi, v_inning_at_pa_start, v_half_at_pa_start, auth.uid()
    ) returning id into v_pa_id;

    if v_outcome = 'walk' and v_rbi = 1 then
      if v_we_are_batting then
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, scorer_player_id)
        values (p_game_id, v_pa_id, 'our', v_scorer_player_id);
      else
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, credited_pitcher_id)
        values (p_game_id, v_pa_id, 'opponent', v_current_pitcher);
      end if;
    end if;
  end if;

  return v_game;
end;
$$;
