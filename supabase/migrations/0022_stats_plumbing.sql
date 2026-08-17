-- ============================================================================
-- LigaFam — Stage 2 of the live-scoring gameplay fixes: stats plumbing.
-- Adds the plate-appearance/runs/advances log tables and wires logging
-- into the stage 1 RPCs (record_count_event, record_batter_hit,
-- move_base_runner), plus season aggregate tables recomputed the same way
-- team_season_records already is (fresh from source rows, on finalize and
-- on event deletion). No UI changes here -- stage 3 builds the display.
-- ============================================================================

-- One row per plate appearance that ends the at-bat (walk, strikeout,
-- generic out, or a hit type). side/batter/pitcher are asymmetric on
-- purpose: when we're batting, batter_player_id is ours and
-- pitcher_player_id is null (opponent pitcher has no players.id); when the
-- opponent bats, pitcher_player_id is ours (for pitching stats) and
-- batter_player_id is null.
create table public.game_plate_appearances (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  side text not null check (side in ('our', 'opponent')),
  batter_player_id uuid references public.players(id) on delete set null,
  pitcher_player_id uuid references public.players(id) on delete set null,
  outcome text not null check (outcome in ('walk', 'strikeout', 'out', 'single', 'double', 'triple', 'home_run')),
  rbi int not null default 0,
  inning int not null,
  inning_half text not null check (inning_half in ('top', 'bottom')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index idx_game_pa_game on public.game_plate_appearances(game_id);
create index idx_game_pa_batter on public.game_plate_appearances(batter_player_id);
create index idx_game_pa_pitcher on public.game_plate_appearances(pitcher_player_id);

-- One row per individual run. scorer_player_id is only ever populated when
-- side='our' (credits that player's R); credited_pitcher_id is only ever
-- populated when side='opponent' (credits our pitcher's runs-allowed) --
-- an opponent run has no identifiable scorer in this app's data model.
create table public.game_runs_scored (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  plate_appearance_id uuid references public.game_plate_appearances(id) on delete set null,
  side text not null check (side in ('our', 'opponent')),
  scorer_player_id uuid references public.players(id) on delete set null,
  credited_pitcher_id uuid references public.players(id) on delete set null,
  created_at timestamptz not null default now()
);
create index idx_game_runs_game on public.game_runs_scored(game_id);

-- One row per explicit "move this runner" action from the diamond --
-- advances, steals, outs-on-the-bases, all tagged with why. Only ever for
-- our players (an existing runner already had identity from the moment
-- they reached base, which per the scoping decision only happens for our
-- team).
create table public.game_runner_advances (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  from_base text not null check (from_base in ('first', 'second', 'third')),
  to_base text not null check (to_base in ('second', 'third', 'home', 'out')),
  reason text not null check (reason in ('hit', 'error', 'steal', 'other')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index idx_game_runner_advances_game on public.game_runner_advances(game_id);
create index idx_game_runner_advances_player on public.game_runner_advances(player_id);

-- Season aggregates -- recomputed fresh on finalize/delete, same pattern
-- as team_season_records, not incrementally bookkept.
create table public.player_season_batting_stats (
  season_id uuid not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  at_bats int not null default 0,
  hits int not null default 0,
  doubles int not null default 0,
  triples int not null default 0,
  home_runs int not null default 0,
  walks int not null default 0,
  strikeouts int not null default 0,
  runs int not null default 0,
  rbi int not null default 0,
  stolen_bases int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (season_id, player_id)
);

create table public.player_season_pitching_stats (
  season_id uuid not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  outs_recorded int not null default 0,
  strikeouts int not null default 0,
  walks_issued int not null default 0,
  hits_allowed int not null default 0,
  runs_allowed int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (season_id, player_id)
);

alter table public.game_plate_appearances enable row level security;
alter table public.game_runs_scored enable row level security;
alter table public.game_runner_advances enable row level security;
alter table public.player_season_batting_stats enable row level security;
alter table public.player_season_pitching_stats enable row level security;

create policy "game_plate_appearances: members read" on public.game_plate_appearances
  for select using (
    exists (
      select 1 from public.games g join public.events e on e.id = g.event_id
      where g.id = game_id and public.is_approved_member(e.team_id)
    )
  );

create policy "game_runs_scored: members read" on public.game_runs_scored
  for select using (
    exists (
      select 1 from public.games g join public.events e on e.id = g.event_id
      where g.id = game_id and public.is_approved_member(e.team_id)
    )
  );

create policy "game_runner_advances: members read" on public.game_runner_advances
  for select using (
    exists (
      select 1 from public.games g join public.events e on e.id = g.event_id
      where g.id = game_id and public.is_approved_member(e.team_id)
    )
  );

create policy "player_season_batting_stats: members read" on public.player_season_batting_stats
  for select using (
    exists (select 1 from public.seasons s where s.id = season_id and public.is_approved_member(s.team_id))
  );

create policy "player_season_pitching_stats: members read" on public.player_season_pitching_stats
  for select using (
    exists (select 1 from public.seasons s where s.id = season_id and public.is_approved_member(s.team_id))
  );

-- ---------------------------------------------------------------------------
-- record_count_event: body-only replace, same (uuid, text, int) signature.
-- Adds: a game_plate_appearances row whenever a PA ends (walk/strikeout/
-- out), and a game_runs_scored row when a bases-loaded walk forces a run
-- in (crediting the scorer on our side, or our pitcher's runs-allowed on
-- the opponent's side). v_scorer_player_id/v_current_pitcher/
-- v_inning_at_pa_start are the only new pieces of state; everything else
-- is unchanged from 0020_batter_outcomes.sql.
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
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_event_type not in ('ball', 'strike', 'out') then raise exception 'INVALID_COUNT_EVENT'; end if;
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

-- ---------------------------------------------------------------------------
-- record_batter_hit: body-only replace, same (uuid, text) signature.
-- Adds a game_plate_appearances row for every hit, and one
-- game_runs_scored row per run scored (crediting each individual scorer on
-- our side, or one runs-allowed row per run on the opponent's side).
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
  if p_hit_type not in ('single', 'double', 'triple', 'home_run') then raise exception 'INVALID_HIT_TYPE'; end if;

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

  else -- 'single'
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
-- signature. Adds a game_runner_advances row for every move (advance,
-- steal, error, out), and a game_runs_scored row when the destination is
-- home. Guarded on v_mover_player_id being non-null -- the UI never opens
-- this menu for the opponent's half (which has no runner identity to
-- move), but the guard keeps the function itself defensive rather than
-- relying solely on that UI restriction.
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
-- recalculate_player_stats: mirrors recalculate_season_record's pattern --
-- recompute fresh from source rows for finalized games only, upsert, and
-- sweep rows for players with nothing left to aggregate (a player can
-- drop out of a season's qualifying set entirely if their one finalized
-- game's event gets deleted).
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
    count(*) filter (where pa.outcome != 'walk'),
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

revoke execute on function public.recalculate_player_stats(uuid) from public;

-- Body-only replaces of the existing trigger functions (0001/0016) -- no
-- new trigger objects, the existing trg_game_finalized/
-- trg_event_deleted_recalc keep firing these same functions.
create or replace function public.on_game_finalized()
returns trigger as $$
declare
  v_season_id uuid;
begin
  if new.status = 'final' and (old.status is distinct from 'final') then
    select season_id into v_season_id from public.events where id = new.event_id;
    if v_season_id is not null then
      perform public.recalculate_season_record(v_season_id);
      perform public.recalculate_player_stats(v_season_id);
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function public.on_event_deleted()
returns trigger
language plpgsql as $$
begin
  perform public.recalculate_season_record(OLD.season_id);
  perform public.recalculate_player_stats(OLD.season_id);
  return OLD;
end;
$$;
