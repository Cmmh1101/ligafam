-- ============================================================================
-- LigaFam — Fix position persistence, one-player-per-position, and add
-- one-step "undo last play".
--
-- set_lineup's full delete+reinsert of game_lineup never carried `position`
-- along, so saving the batting order after assigning positions silently
-- wiped them back to null -- confirmed directly against real production
-- data. Fixed by preserving position across the reinsert.
--
-- set_lineup_position didn't enforce one-player-per-position; fixed by
-- clearing the position from whoever previously held it.
--
-- Undo: a single-row-per-game snapshot table (game_undo_state), written by
-- the four "cascading play" RPCs (record_count_event only when a plate
-- appearance actually ends, record_batter_hit, move_base_runner,
-- substitute_lineup_player) right after they do their normal work. Each
-- write captures a full jsonb snapshot of the games row from *before* the
-- change, plus the ids of whatever it just inserted into
-- game_plate_appearances/game_runs_scored/game_runner_advances (and, for a
-- substitution, the affected game_lineup row's prior player_id) so undo can
-- restore the games row and delete exactly those log rows -- keeping
-- season stats accurate, not just visually reverting the scoreboard.
-- ============================================================================

create table public.game_undo_state (
  game_id uuid primary key references public.games(id) on delete cascade,
  action text not null check (action in ('count_event', 'batter_hit', 'runner_move', 'substitution')),
  games_snapshot jsonb not null,
  lineup_row_id uuid,
  lineup_prior_player_id uuid,
  plate_appearance_ids uuid[] not null default '{}',
  runs_scored_ids uuid[] not null default '{}',
  runner_advance_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.game_undo_state enable row level security;

create policy "game_undo_state: members read" on public.game_undo_state
  for select using (
    exists (
      select 1 from public.games g join public.events e on e.id = g.event_id
      where g.id = game_id and public.is_approved_member(e.team_id)
    )
  );

-- ---------------------------------------------------------------------------
-- set_lineup: body-only replace, same (uuid, uuid[]) signature. Only
-- change from 0009's version: preserves each player's existing `position`
-- across the delete+reinsert via a data-modifying CTE.
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

  with old as (
    delete from public.game_lineup where game_id = p_game_id
    returning player_id, position
  )
  insert into public.game_lineup (game_id, player_id, batting_order, position)
  select p_game_id, t.pid, t.ord, old.position
  from unnest(p_player_ids) with ordinality as t(pid, ord)
  left join old on old.player_id = t.pid;

  update public.games set current_batter_player_id = p_player_ids[1] where id = p_game_id;

  return query select * from public.game_lineup where game_id = p_game_id order by batting_order;
end;
$$;

-- ---------------------------------------------------------------------------
-- set_lineup_position: body-only replace, same signature. Only change
-- from 0025's version: enforces one-player-per-position by clearing the
-- position from whoever previously held it.
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

  if p_position is not null then
    update public.game_lineup set position = null
    where game_id = p_game_id and position = p_position and player_id != p_player_id;
  end if;

  update public.game_lineup set position = p_position
  where game_id = p_game_id and player_id = p_player_id
  returning * into v_row;

  if v_row.id is null then raise exception 'PLAYER_NOT_IN_LINEUP'; end if;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_count_event: body-only replace, same (uuid, text, int) signature.
-- Only change from 0026's version: snapshots the games row before any
-- mutation, and -- only when a plate appearance actually ends (a ball/
-- strike +/- that doesn't complete the at-bat isn't a "play" to undo, the
-- existing -1 buttons already cover that) -- upserts game_undo_state with
-- that snapshot plus the plate-appearance/runs-scored ids it just logged.
-- ---------------------------------------------------------------------------
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
  v_games_snapshot jsonb;
  v_runs_scored_id uuid;
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

  select to_jsonb(g) into v_games_snapshot from public.games g where g.id = p_game_id;

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
        values (p_game_id, v_pa_id, 'our', v_scorer_player_id)
        returning id into v_runs_scored_id;
      else
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, credited_pitcher_id)
        values (p_game_id, v_pa_id, 'opponent', v_current_pitcher)
        returning id into v_runs_scored_id;
      end if;
    end if;

    insert into public.game_undo_state (
      game_id, action, games_snapshot, plate_appearance_ids, runs_scored_ids
    ) values (
      p_game_id, 'count_event', v_games_snapshot, array[v_pa_id],
      case when v_runs_scored_id is not null then array[v_runs_scored_id] else array[]::uuid[] end
    )
    on conflict (game_id) do update set
      action = excluded.action, games_snapshot = excluded.games_snapshot,
      lineup_row_id = null, lineup_prior_player_id = null,
      plate_appearance_ids = excluded.plate_appearance_ids,
      runs_scored_ids = excluded.runs_scored_ids,
      runner_advance_ids = '{}', created_at = now();
  end if;

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- record_batter_hit: body-only replace, same (uuid, text) signature. Only
-- change from 0027's version: snapshots the games row before any mutation
-- and upserts game_undo_state with that snapshot plus the plate-appearance/
-- runs-scored ids it just logged (every hit is a "play").
-- ---------------------------------------------------------------------------
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
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_hit_type not in ('single', 'double', 'triple', 'home_run', 'hbp') then raise exception 'INVALID_HIT_TYPE'; end if;

  select status, current_inning, inning_half, home_or_away, current_batter_player_id, current_opponent_batter_id,
         current_pitcher_player_id,
         runner_on_first, runner_on_second, runner_on_third,
         runner_on_first_player_id, runner_on_second_player_id, runner_on_third_player_id,
         our_score, opponent_score
    into v_status, v_inning, v_half, v_home_or_away, v_current_batter, v_current_opponent_batter,
         v_current_pitcher,
         v_runner_on_first, v_runner_on_second, v_runner_on_third,
         v_runner_on_first_player_id, v_runner_on_second_player_id, v_runner_on_third_player_id,
         v_our_score, v_opponent_score
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
        current_batter_player_id = v_next_batter, current_opponent_batter_id = v_next_opponent_batter
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

-- ---------------------------------------------------------------------------
-- move_base_runner: body-only replace, same (uuid, text, text, text)
-- signature. Only change from 0024's version: snapshots the games row
-- before any mutation and -- only when there's a real identified mover
-- (opponent side never logs anything, same as today) -- upserts
-- game_undo_state with that snapshot plus the runner-advance/runs-scored
-- ids it just logged.
-- ---------------------------------------------------------------------------
create or replace function public.move_base_runner(
  p_game_id uuid, p_from_base text, p_to_base text, p_reason text
) returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_half text; v_inning int; v_outs int; v_home_or_away text;
  v_our_score int; v_opponent_score int;
  v_mover_player_id uuid; v_mover_occupied boolean;
  v_we_are_batting boolean;
  v_game public.games;
  v_games_snapshot jsonb;
  v_advance_id uuid;
  v_run_id uuid;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  if p_from_base not in ('first', 'second', 'third') then raise exception 'INVALID_BASE'; end if;
  if p_to_base not in ('second', 'third', 'home', 'out') then raise exception 'INVALID_BASE'; end if;
  if p_reason not in ('hit', 'error', 'steal', 'other', 'balk') then raise exception 'INVALID_MOVE_REASON'; end if;
  if p_from_base = 'second' and p_to_base not in ('third', 'home', 'out') then raise exception 'INVALID_BASE'; end if;
  if p_from_base = 'third' and p_to_base not in ('home', 'out') then raise exception 'INVALID_BASE'; end if;

  select status, current_inning, inning_half, outs, home_or_away, our_score, opponent_score
    into v_status, v_inning, v_half, v_outs, v_home_or_away, v_our_score, v_opponent_score
  from public.games where id = p_game_id for update;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  select to_jsonb(g) into v_games_snapshot from public.games g where g.id = p_game_id;

  if p_from_base = 'first' then
    select runner_on_first_player_id, runner_on_first into v_mover_player_id, v_mover_occupied from public.games where id = p_game_id;
  elsif p_from_base = 'second' then
    select runner_on_second_player_id, runner_on_second into v_mover_player_id, v_mover_occupied from public.games where id = p_game_id;
  else
    select runner_on_third_player_id, runner_on_third into v_mover_player_id, v_mover_occupied from public.games where id = p_game_id;
  end if;

  if not coalesce(v_mover_occupied, false) then raise exception 'NO_RUNNER_ON_BASE'; end if;

  if p_from_base = 'first' then
    update public.games set runner_on_first = false, runner_on_first_player_id = null where id = p_game_id;
  elsif p_from_base = 'second' then
    update public.games set runner_on_second = false, runner_on_second_player_id = null where id = p_game_id;
  else
    update public.games set runner_on_third = false, runner_on_third_player_id = null where id = p_game_id;
  end if;

  if p_to_base = 'second' then
    update public.games set runner_on_second = true, runner_on_second_player_id = v_mover_player_id where id = p_game_id;
  elsif p_to_base = 'third' then
    update public.games set runner_on_third = true, runner_on_third_player_id = v_mover_player_id where id = p_game_id;
  elsif p_to_base = 'home' then
    v_we_are_batting := v_home_or_away is not null and (
      (v_half = 'top' and v_home_or_away = 'away') or (v_half = 'bottom' and v_home_or_away = 'home')
    );
    if v_home_or_away is not null then
      if v_we_are_batting then v_our_score := v_our_score + 1; else v_opponent_score := v_opponent_score + 1; end if;
    end if;
    update public.games set our_score = v_our_score, opponent_score = v_opponent_score where id = p_game_id;
  else -- 'out'
    v_outs := v_outs + 1;
    if v_outs >= 3 then
      v_outs := 0;
      if v_half = 'top' then v_half := 'bottom'; else v_half := 'top'; v_inning := v_inning + 1; end if;
      update public.games
        set outs = v_outs, inning_half = v_half, current_inning = v_inning, status = 'live',
            runner_on_first = false, runner_on_second = false, runner_on_third = false,
            runner_on_first_player_id = null, runner_on_second_player_id = null, runner_on_third_player_id = null
        where id = p_game_id;
    else
      update public.games set outs = v_outs, status = 'live' where id = p_game_id;
    end if;
  end if;

  if v_mover_player_id is not null then
    insert into public.game_runner_advances (game_id, player_id, from_base, to_base, reason, created_by)
    values (p_game_id, v_mover_player_id, p_from_base, p_to_base, p_reason, auth.uid())
    returning id into v_advance_id;

    if p_to_base = 'home' then
      insert into public.game_runs_scored (game_id, side, scorer_player_id)
      values (p_game_id, 'our', v_mover_player_id)
      returning id into v_run_id;
    end if;

    insert into public.game_undo_state (
      game_id, action, games_snapshot, runner_advance_ids, runs_scored_ids
    ) values (
      p_game_id, 'runner_move', v_games_snapshot, array[v_advance_id],
      case when v_run_id is not null then array[v_run_id] else array[]::uuid[] end
    )
    on conflict (game_id) do update set
      action = excluded.action, games_snapshot = excluded.games_snapshot,
      lineup_row_id = null, lineup_prior_player_id = null,
      plate_appearance_ids = '{}',
      runs_scored_ids = excluded.runs_scored_ids,
      runner_advance_ids = excluded.runner_advance_ids, created_at = now();
  end if;

  update public.games set status = 'live' where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- substitute_lineup_player: body-only replace, same (uuid, uuid, uuid)
-- signature. Only change from 0020's version: snapshots the games row and
-- the affected game_lineup row's prior player_id before the swap, and
-- upserts game_undo_state.
-- ---------------------------------------------------------------------------
create or replace function public.substitute_lineup_player(
  p_game_id uuid, p_outgoing_player_id uuid, p_incoming_player_id uuid
) returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_current_batter uuid;
  v_runner_on_first_player_id uuid; v_runner_on_second_player_id uuid; v_runner_on_third_player_id uuid;
  v_game public.games;
  v_games_snapshot jsonb;
  v_lineup_row_id uuid;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  if p_outgoing_player_id = p_incoming_player_id then raise exception 'INVALID_PLAYER_SELECTION'; end if;
  if not exists (select 1 from public.players where id = p_incoming_player_id and team_id = v_team_id) then
    raise exception 'INVALID_PLAYER_SELECTION';
  end if;

  select status, current_batter_player_id,
         runner_on_first_player_id, runner_on_second_player_id, runner_on_third_player_id
    into v_status, v_current_batter,
         v_runner_on_first_player_id, v_runner_on_second_player_id, v_runner_on_third_player_id
  from public.games where id = p_game_id for update;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  select to_jsonb(g) into v_games_snapshot from public.games g where g.id = p_game_id;

  select id into v_lineup_row_id from public.game_lineup
  where game_id = p_game_id and player_id = p_outgoing_player_id;
  if v_lineup_row_id is null then raise exception 'PLAYER_NOT_IN_LINEUP'; end if;
  if exists (select 1 from public.game_lineup where game_id = p_game_id and player_id = p_incoming_player_id) then
    raise exception 'PLAYER_ALREADY_IN_LINEUP';
  end if;

  update public.game_lineup
    set player_id = p_incoming_player_id
    where id = v_lineup_row_id;

  update public.games
    set current_batter_player_id = case when current_batter_player_id = p_outgoing_player_id
                                         then p_incoming_player_id else current_batter_player_id end,
        runner_on_first_player_id = case when runner_on_first_player_id = p_outgoing_player_id
                                          then p_incoming_player_id else runner_on_first_player_id end,
        runner_on_second_player_id = case when runner_on_second_player_id = p_outgoing_player_id
                                           then p_incoming_player_id else runner_on_second_player_id end,
        runner_on_third_player_id = case when runner_on_third_player_id = p_outgoing_player_id
                                          then p_incoming_player_id else runner_on_third_player_id end
    where id = p_game_id
    returning * into v_game;

  insert into public.game_undo_state (
    game_id, action, games_snapshot, lineup_row_id, lineup_prior_player_id
  ) values (
    p_game_id, 'substitution', v_games_snapshot, v_lineup_row_id, p_outgoing_player_id
  )
  on conflict (game_id) do update set
    action = excluded.action, games_snapshot = excluded.games_snapshot,
    lineup_row_id = excluded.lineup_row_id, lineup_prior_player_id = excluded.lineup_prior_player_id,
    plate_appearance_ids = '{}', runs_scored_ids = '{}', runner_advance_ids = '{}', created_at = now();

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- undo_last_play: new RPC. Restores the games row from the most recent
-- game_undo_state snapshot, deletes exactly the stats-log rows that play
-- created, restores the one game_lineup row if a substitution is being
-- undone, then deletes the undo record itself (one-step only).
-- ---------------------------------------------------------------------------
create or replace function public.undo_last_play(p_game_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_undo public.game_undo_state;
  v_game public.games;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  select status into v_status from public.games where id = p_game_id for update;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  select * into v_undo from public.game_undo_state where game_id = p_game_id;
  if v_undo.game_id is null then raise exception 'NOTHING_TO_UNDO'; end if;

  delete from public.game_plate_appearances where id = any(v_undo.plate_appearance_ids);
  delete from public.game_runs_scored where id = any(v_undo.runs_scored_ids);
  delete from public.game_runner_advances where id = any(v_undo.runner_advance_ids);

  if v_undo.lineup_row_id is not null then
    update public.game_lineup set player_id = v_undo.lineup_prior_player_id where id = v_undo.lineup_row_id;
  end if;

  update public.games g
    set status = (v_undo.games_snapshot->>'status')::public.game_status,
        our_score = (v_undo.games_snapshot->>'our_score')::int,
        opponent_score = (v_undo.games_snapshot->>'opponent_score')::int,
        current_inning = (v_undo.games_snapshot->>'current_inning')::int,
        inning_half = v_undo.games_snapshot->>'inning_half',
        outs = (v_undo.games_snapshot->>'outs')::int,
        balls = (v_undo.games_snapshot->>'balls')::int,
        strikes = (v_undo.games_snapshot->>'strikes')::int,
        current_batter_player_id = (v_undo.games_snapshot->>'current_batter_player_id')::uuid,
        current_opponent_batter_id = (v_undo.games_snapshot->>'current_opponent_batter_id')::uuid,
        current_pitcher_player_id = (v_undo.games_snapshot->>'current_pitcher_player_id')::uuid,
        our_pitcher_pitch_count = (v_undo.games_snapshot->>'our_pitcher_pitch_count')::int,
        opponent_pitcher_pitch_count = (v_undo.games_snapshot->>'opponent_pitcher_pitch_count')::int,
        last_pitch_charged_to = v_undo.games_snapshot->>'last_pitch_charged_to',
        runner_on_first = (v_undo.games_snapshot->>'runner_on_first')::boolean,
        runner_on_second = (v_undo.games_snapshot->>'runner_on_second')::boolean,
        runner_on_third = (v_undo.games_snapshot->>'runner_on_third')::boolean,
        runner_on_first_player_id = (v_undo.games_snapshot->>'runner_on_first_player_id')::uuid,
        runner_on_second_player_id = (v_undo.games_snapshot->>'runner_on_second_player_id')::uuid,
        runner_on_third_player_id = (v_undo.games_snapshot->>'runner_on_third_player_id')::uuid
    where g.id = p_game_id
    returning * into v_game;

  delete from public.game_undo_state where game_id = p_game_id;

  return v_game;
end;
$$;

revoke execute on function public.undo_last_play(uuid) from public;
grant execute on function public.undo_last_play(uuid) to authenticated;
