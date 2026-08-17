-- ============================================================================
-- LigaFam — Stage 1 of the live-scoring gameplay fixes: walk force-advance,
-- explicit hit outcomes, manual batter override, mid-game substitution, and
-- an explicit "move this runner" gesture. Runner identity (who, not just
-- whether, is on each base) is tracked for OUR team only -- the opponent
-- side has no persistent player identity in this app (game_opponent_lineup
-- rows are per-game free text), so opponent base occupancy stays
-- boolean-only, exactly as before.
--
-- Deliberately no new tables here (stats logging is stage 2, layered on top
-- of these same RPCs via a later body-only update) -- everything below only
-- needs the three new `games` columns.
-- ============================================================================

alter table public.games
  add column runner_on_first_player_id uuid references public.players(id) on delete set null,
  add column runner_on_second_player_id uuid references public.players(id) on delete set null,
  add column runner_on_third_player_id uuid references public.players(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 1. set_base_runner: signature change (new optional p_player_id) -- still
-- the manual "place a runner from nothing" tool (fielder's choice, HBP,
-- corrections). Occupying a base carries identity only when given (our
-- half); clearing a base always clears identity too, regardless of side.
-- ---------------------------------------------------------------------------
drop function if exists public.set_base_runner(uuid, text, boolean);

create or replace function public.set_base_runner(
  p_game_id uuid, p_base text, p_occupied boolean, p_player_id uuid default null
) returns public.games
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

  if p_player_id is not null and not exists (select 1 from public.players where id = p_player_id and team_id = v_team_id) then
    raise exception 'INVALID_PLAYER_SELECTION';
  end if;

  if p_base = 'first' then
    update public.games
      set runner_on_first = p_occupied,
          runner_on_first_player_id = case when p_occupied then p_player_id else null end
      where id = p_game_id returning * into v_game;
  elsif p_base = 'second' then
    update public.games
      set runner_on_second = p_occupied,
          runner_on_second_player_id = case when p_occupied then p_player_id else null end
      where id = p_game_id returning * into v_game;
  else
    update public.games
      set runner_on_third = p_occupied,
          runner_on_third_player_id = case when p_occupied then p_player_id else null end
      where id = p_game_id returning * into v_game;
  end if;

  return v_game;
end;
$$;

revoke execute on function public.set_base_runner(uuid, text, boolean, uuid) from public;
grant execute on function public.set_base_runner(uuid, text, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. record_count_event: body-only replace, same (uuid, text, int)
-- signature. Adds the walk force-advance cascade (bases move only when
-- actually forced) carrying runner identity for our half only. Everything
-- else (pitch count attribution, PA-end batter-advance, inning transition)
-- is unchanged from 0013_base_runners.sql.
-- ---------------------------------------------------------------------------
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
  v_runner_on_first_player_id uuid; v_runner_on_second_player_id uuid; v_runner_on_third_player_id uuid;
  v_our_score int; v_opponent_score int;
  v_run_scored boolean;
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
         runner_on_first, runner_on_second, runner_on_third,
         runner_on_first_player_id, runner_on_second_player_id, runner_on_third_player_id,
         our_score, opponent_score
    into v_balls, v_strikes, v_outs, v_inning, v_half, v_status, v_home_or_away,
         v_current_batter, v_current_opponent_batter,
         v_our_pitch_count, v_opponent_pitch_count, v_last_pitch_charged_to,
         v_runner_on_first, v_runner_on_second, v_runner_on_third,
         v_runner_on_first_player_id, v_runner_on_second_player_id, v_runner_on_third_player_id,
         v_our_score, v_opponent_score
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
      if v_balls >= 4 then
        v_balls := 0; v_strikes := 0; v_pa_ended := true;

        -- Identity cascade first (reads the OLD booleans below, still
        -- intact) -- third depends on old first+second, second depends on
        -- old first, matching the boolean cascade's dependency order.
        -- Only carried when it's our half; the opponent side never gets
        -- runner identity.
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
          if v_we_are_batting then v_our_score := v_our_score + 1; else v_opponent_score := v_opponent_score + 1; end if;
        end if;
      end if;
    elsif p_event_type = 'strike' then
      v_strikes := v_strikes + 1;
      if v_strikes >= 3 then v_strikes := 0; v_balls := 0; v_outs := v_outs + 1; v_pa_ended := true; end if;
    else
      v_balls := 0; v_strikes := 0; v_outs := v_outs + 1; v_pa_ended := true;
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

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. record_batter_hit (new): 1B/2B/3B place only the current batter --
-- existing runners are left exactly where they are (real advancement on a
-- hit is situational, not a fixed rule; the admin corrects it by hand via
-- move_base_runner below). Home run is the one deterministic case: the
-- batter and every occupied base all score, bases clear.
-- ---------------------------------------------------------------------------
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
  v_our_score int; v_opponent_score int;
  v_we_are_batting boolean;
  v_game public.games;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_hit_type not in ('single', 'double', 'triple', 'home_run') then raise exception 'INVALID_HIT_TYPE'; end if;

  select status, inning_half, home_or_away, current_batter_player_id, current_opponent_batter_id,
         runner_on_first, runner_on_second, runner_on_third, our_score, opponent_score
    into v_status, v_half, v_home_or_away, v_current_batter, v_current_opponent_batter,
         v_runner_on_first, v_runner_on_second, v_runner_on_third, v_our_score, v_opponent_score
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_next_batter := v_current_batter;
  v_next_opponent_batter := v_current_opponent_batter;
  v_we_are_batting := v_home_or_away is not null and (
    (v_half = 'top' and v_home_or_away = 'away') or (v_half = 'bottom' and v_home_or_away = 'home')
  );

  if p_hit_type = 'home_run' then
    -- Batter scores; every currently-occupied base also scores (real rule,
    -- not a guess). Bases clear either way.
    declare
      v_runs int := 1;
    begin
      if v_runner_on_first then v_runs := v_runs + 1; end if;
      if v_runner_on_second then v_runs := v_runs + 1; end if;
      if v_runner_on_third then v_runs := v_runs + 1; end if;

      if v_home_or_away is not null then
        if v_we_are_batting then v_our_score := v_our_score + v_runs; else v_opponent_score := v_opponent_score + v_runs; end if;
      end if;
    end;

    update public.games
      set runner_on_first = false, runner_on_second = false, runner_on_third = false,
          runner_on_first_player_id = null, runner_on_second_player_id = null, runner_on_third_player_id = null
      where id = p_game_id;
  else
    -- single/double/triple: place only the new batter, our half only gets
    -- identity (opponent's batter has no players.id to store).
    if p_hit_type = 'single' then
      update public.games
        set runner_on_first = true,
            runner_on_first_player_id = case when v_we_are_batting then v_current_batter else null end
        where id = p_game_id;
    elsif p_hit_type = 'double' then
      update public.games
        set runner_on_second = true,
            runner_on_second_player_id = case when v_we_are_batting then v_current_batter else null end
        where id = p_game_id;
    else
      update public.games
        set runner_on_third = true,
            runner_on_third_player_id = case when v_we_are_batting then v_current_batter else null end
        where id = p_game_id;
    end if;
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
        our_score = v_our_score, opponent_score = v_opponent_score,
        current_batter_player_id = v_next_batter, current_opponent_batter_id = v_next_opponent_batter
    where id = p_game_id
    returning * into v_game;

  return v_game;
end;
$$;

revoke execute on function public.record_batter_hit(uuid, text) from public;
grant execute on function public.record_batter_hit(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. set_current_batter (new): pure "who's up" correction, no side effects
-- on count/outs/inning. What "Resume order from this hitter" calls --
-- next_lineup_batter already just walks forward sequentially from
-- current_batter_player_id, so setting it here is all that's needed for
-- the game to continue in order from the newly-picked player.
-- ---------------------------------------------------------------------------
create or replace function public.set_current_batter(p_game_id uuid, p_player_id uuid)
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

  if not exists (select 1 from public.game_lineup where game_id = p_game_id and player_id = p_player_id) then
    raise exception 'PLAYER_NOT_IN_LINEUP';
  end if;

  update public.games set current_batter_player_id = p_player_id where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

revoke execute on function public.set_current_batter(uuid, uuid) from public;
grant execute on function public.set_current_batter(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. substitute_lineup_player (new): what both "Replace current hitter"
-- and the lineup tab's per-row swap icon call. A single-row update on
-- game_lineup (not delete+insert) preserves batting_order and row identity
-- -- unlike set_lineup's full replace, this never resets
-- current_batter_player_id to the leadoff batter. Also reattributes any
-- base the outgoing player is currently standing on (pinch-runner case) --
-- otherwise a substituted-out player could be left "on base" while no
-- longer even in the lineup.
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

  if not exists (select 1 from public.game_lineup where game_id = p_game_id and player_id = p_outgoing_player_id) then
    raise exception 'PLAYER_NOT_IN_LINEUP';
  end if;
  if exists (select 1 from public.game_lineup where game_id = p_game_id and player_id = p_incoming_player_id) then
    raise exception 'PLAYER_ALREADY_IN_LINEUP';
  end if;

  update public.game_lineup
    set player_id = p_incoming_player_id
    where game_id = p_game_id and player_id = p_outgoing_player_id;

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

  return v_game;
end;
$$;

revoke execute on function public.substitute_lineup_player(uuid, uuid, uuid) from public;
grant execute on function public.substitute_lineup_player(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. move_base_runner (new): the diamond's "move this runner" menu.
-- p_reason is accepted and validated now (client always sends it) but not
-- yet persisted anywhere -- stage 2 adds the game_runner_advances log (and
-- game_runs_scored for the home case) via a body-only update once those
-- tables exist. The gameplay effect itself is complete here: advancing,
-- scoring, and getting thrown out (including the 3rd-out half-inning flip)
-- all work today.
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
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  if p_from_base not in ('first', 'second', 'third') then raise exception 'INVALID_BASE'; end if;
  if p_to_base not in ('second', 'third', 'home', 'out') then raise exception 'INVALID_BASE'; end if;
  if p_reason not in ('hit', 'error', 'steal', 'other') then raise exception 'INVALID_MOVE_REASON'; end if;
  if p_from_base = 'second' and p_to_base not in ('third', 'home', 'out') then raise exception 'INVALID_BASE'; end if;
  if p_from_base = 'third' and p_to_base not in ('home', 'out') then raise exception 'INVALID_BASE'; end if;

  select status, current_inning, inning_half, outs, home_or_away, our_score, opponent_score
    into v_status, v_inning, v_half, v_outs, v_home_or_away, v_our_score, v_opponent_score
  from public.games where id = p_game_id for update;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  if p_from_base = 'first' then
    select runner_on_first_player_id, runner_on_first into v_mover_player_id, v_mover_occupied from public.games where id = p_game_id;
  elsif p_from_base = 'second' then
    select runner_on_second_player_id, runner_on_second into v_mover_player_id, v_mover_occupied from public.games where id = p_game_id;
  else
    select runner_on_third_player_id, runner_on_third into v_mover_player_id, v_mover_occupied from public.games where id = p_game_id;
  end if;

  if not coalesce(v_mover_occupied, false) then raise exception 'NO_RUNNER_ON_BASE'; end if;

  -- Clear the source base first (both branches below are independent of it).
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

  update public.games set status = 'live' where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

revoke execute on function public.move_base_runner(uuid, text, text, text) from public;
grant execute on function public.move_base_runner(uuid, text, text, text) to authenticated;
