-- ============================================================================
-- LigaFam — Live-scoring round 2: hit-by-pitch and balk.
--
-- Both record_batter_hit and move_base_runner are already fully
-- side-symmetric (they infer which side is batting from game state, not a
-- parameter) -- these are validation-list-only body replaces, no other
-- logic changes. HBP reuses record_batter_hit's existing catch-all "single"
-- branch (force-cascade placement), since that's exactly hit-by-pitch's
-- placement rule too.
-- ============================================================================

alter table public.game_plate_appearances drop constraint game_plate_appearances_outcome_check;
alter table public.game_plate_appearances add constraint game_plate_appearances_outcome_check
  check (outcome in ('walk', 'strikeout', 'out', 'single', 'double', 'triple', 'home_run', 'hbp'));

alter table public.game_runner_advances drop constraint game_runner_advances_reason_check;
alter table public.game_runner_advances add constraint game_runner_advances_reason_check
  check (reason in ('hit', 'error', 'steal', 'other', 'balk'));

-- ---------------------------------------------------------------------------
-- record_batter_hit: body-only replace, same (uuid, text) signature. Only
-- change from 0022's version is 'hbp' added to the allowed p_hit_type list
-- -- it falls into the existing "single" else-branch below, which is
-- already the correct force-cascade placement for a hit-by-pitch batter.
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
    if v_runner_on_third then v_runs := v_runs + 1; v_scored_third := true; end if;
    v_new_r1 := v_runner_on_first; v_new_r1_id := v_runner_on_first_player_id;
    v_new_r2 := v_runner_on_second; v_new_r2_id := v_runner_on_second_player_id;
    v_new_r3 := true; v_new_r3_id := v_batter_id;

  elsif p_hit_type = 'double' then
    v_new_r1 := v_runner_on_first; v_new_r1_id := v_runner_on_first_player_id;
    if v_runner_on_second then
      if v_runner_on_third then v_runs := v_runs + 1; v_scored_third := true; end if;
      v_new_r3 := true; v_new_r3_id := v_runner_on_second_player_id;
    else
      v_new_r3 := v_runner_on_third; v_new_r3_id := v_runner_on_third_player_id;
    end if;
    v_new_r2 := true; v_new_r2_id := v_batter_id;

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
        values (p_game_id, v_pa_id, 'our', v_runner_on_first_player_id);
      end if;
      if v_scored_second then
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, scorer_player_id)
        values (p_game_id, v_pa_id, 'our', v_runner_on_second_player_id);
      end if;
      if v_scored_third then
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, scorer_player_id)
        values (p_game_id, v_pa_id, 'our', v_runner_on_third_player_id);
      end if;
      if v_batter_scored then
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, scorer_player_id)
        values (p_game_id, v_pa_id, 'our', v_batter_id);
      end if;
    else
      for v_i in 1..v_runs loop
        insert into public.game_runs_scored (game_id, plate_appearance_id, side, credited_pitcher_id)
        values (p_game_id, v_pa_id, 'opponent', v_current_pitcher);
      end loop;
    end if;
  end if;

  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- move_base_runner: body-only replace, same (uuid, text, text, text)
-- signature. Only change from 0022's version is 'balk' added to the
-- allowed p_reason list.
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
  v_pa_id uuid;
  v_game public.games;
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
    values (p_game_id, v_mover_player_id, p_from_base, p_to_base, p_reason, auth.uid());

    if p_to_base = 'home' then
      insert into public.game_runs_scored (game_id, side, scorer_player_id)
      values (p_game_id, 'our', v_mover_player_id);
    end if;
  end if;

  update public.games set status = 'live' where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

-- ---------------------------------------------------------------------------
-- recalculate_player_stats: body-only replace, same (uuid) signature. Only
-- change from 0022's version is at_bats also excluding 'hbp', same
-- treatment as 'walk'.
-- ---------------------------------------------------------------------------
create or replace function public.recalculate_player_stats(p_season_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_season_id is null or not exists (select 1 from public.seasons where id = p_season_id) then
    return;
  end if;

  insert into public.player_season_batting_stats (
    season_id, player_id, at_bats, hits, doubles, triples, home_runs, walks, strikeouts, runs, rbi, stolen_bases, updated_at
  )
  select
    p_season_id,
    pa.batter_player_id,
    count(*) filter (where pa.outcome not in ('walk', 'hbp')),
    count(*) filter (where pa.outcome in ('single', 'double', 'triple', 'home_run')),
    count(*) filter (where pa.outcome = 'double'),
    count(*) filter (where pa.outcome = 'triple'),
    count(*) filter (where pa.outcome = 'home_run'),
    count(*) filter (where pa.outcome = 'walk'),
    count(*) filter (where pa.outcome = 'strikeout'),
    coalesce((
      select count(*) from public.game_runs_scored rs
      join public.games g2 on g2.id = rs.game_id
      join public.events e2 on e2.id = g2.event_id
      where e2.season_id = p_season_id and g2.status = 'final'
        and rs.side = 'our' and rs.scorer_player_id = pa.batter_player_id
    ), 0),
    coalesce(sum(pa.rbi), 0),
    coalesce((
      select count(*) from public.game_runner_advances ra
      join public.games g3 on g3.id = ra.game_id
      join public.events e3 on e3.id = g3.event_id
      where e3.season_id = p_season_id and g3.status = 'final'
        and ra.reason = 'steal' and ra.to_base != 'out' and ra.player_id = pa.batter_player_id
    ), 0),
    now()
  from public.game_plate_appearances pa
  join public.games g on g.id = pa.game_id
  join public.events e on e.id = g.event_id
  where e.season_id = p_season_id and g.status = 'final' and pa.side = 'our' and pa.batter_player_id is not null
  group by pa.batter_player_id
  on conflict (season_id, player_id) do update
    set at_bats = excluded.at_bats, hits = excluded.hits, doubles = excluded.doubles, triples = excluded.triples,
        home_runs = excluded.home_runs, walks = excluded.walks, strikeouts = excluded.strikeouts,
        runs = excluded.runs, rbi = excluded.rbi, stolen_bases = excluded.stolen_bases, updated_at = now();

  delete from public.player_season_batting_stats pbs
  where pbs.season_id = p_season_id
    and not exists (
      select 1 from public.game_plate_appearances pa2
      join public.games g2 on g2.id = pa2.game_id
      join public.events e2 on e2.id = g2.event_id
      where e2.season_id = p_season_id and g2.status = 'final'
        and pa2.side = 'our' and pa2.batter_player_id = pbs.player_id
    );

  insert into public.player_season_pitching_stats (
    season_id, player_id, outs_recorded, strikeouts, walks_issued, hits_allowed, runs_allowed, updated_at
  )
  select
    p_season_id,
    pa.pitcher_player_id,
    count(*) filter (where pa.outcome in ('strikeout', 'out')),
    count(*) filter (where pa.outcome = 'strikeout'),
    count(*) filter (where pa.outcome = 'walk'),
    count(*) filter (where pa.outcome in ('single', 'double', 'triple', 'home_run')),
    coalesce((
      select count(*) from public.game_runs_scored rs
      join public.games g2 on g2.id = rs.game_id
      join public.events e2 on e2.id = g2.event_id
      where e2.season_id = p_season_id and g2.status = 'final'
        and rs.side = 'opponent' and rs.credited_pitcher_id = pa.pitcher_player_id
    ), 0),
    now()
  from public.game_plate_appearances pa
  join public.games g on g.id = pa.game_id
  join public.events e on e.id = g.event_id
  where e.season_id = p_season_id and g.status = 'final' and pa.side = 'opponent' and pa.pitcher_player_id is not null
  group by pa.pitcher_player_id
  on conflict (season_id, player_id) do update
    set outs_recorded = excluded.outs_recorded, strikeouts = excluded.strikeouts, walks_issued = excluded.walks_issued,
        hits_allowed = excluded.hits_allowed, runs_allowed = excluded.runs_allowed, updated_at = now();

  delete from public.player_season_pitching_stats pps
  where pps.season_id = p_season_id
    and not exists (
      select 1 from public.game_plate_appearances pa2
      join public.games g2 on g2.id = pa2.game_id
      join public.events e2 on e2.id = g2.event_id
      where e2.season_id = p_season_id and g2.status = 'final'
        and pa2.side = 'opponent' and pa2.pitcher_player_id = pps.player_id
    );
end;
$$;
