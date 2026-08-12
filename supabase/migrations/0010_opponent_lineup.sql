-- ============================================================================
-- LigaFam — Opponent lineup/pitcher, dual-sided batting/pitching display fix
--
-- Fixes a real bug: the scoreboard always labeled games.current_pitcher_player_id
-- (our pitcher) as "Lanzando" regardless of which team was actually pitching --
-- wrong during our own at-bat, when the opponent is pitching, not us. Adds an
-- ad-hoc (per-game, not persistent/reusable) opponent lineup + pitcher, and
-- makes record_count_event's auto-advance symmetric across both sides.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. New table + columns. Must come first in the file -- functions below
-- reference these.
-- ---------------------------------------------------------------------------
create table public.game_opponent_lineup (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  batting_order int not null check (batting_order > 0),
  display_name text,
  jersey_number text,
  unique (game_id, batting_order)
);

alter table public.game_opponent_lineup enable row level security;

create policy "game_opponent_lineup: members read" on public.game_opponent_lineup
  for select using (
    exists (
      select 1 from public.games g join public.events e on e.id = g.event_id
      where g.id = game_id and public.is_approved_member(e.team_id)
    )
  );
-- Deliberately no write policy at all -- RPC-only from day one (games and
-- game_lineup both needed a follow-up migration to retrofit this; starting
-- this table there directly).

alter table public.games
  add column opponent_pitcher_name text,
  add column opponent_pitcher_number text,
  add column current_opponent_batter_id uuid references public.game_opponent_lineup(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 2. next_opponent_lineup_batter: mirrors next_lineup_batter, keyed by the
-- game_opponent_lineup.id PK directly (no external roster identity to key
-- on). Internal-only helper, no grant to authenticated.
-- ---------------------------------------------------------------------------
create or replace function public.next_opponent_lineup_batter(p_game_id uuid, p_current_id uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (
      select id from public.game_opponent_lineup
      where game_id = p_game_id
        and batting_order > (
          select batting_order from public.game_opponent_lineup
          where id = p_current_id and game_id = p_game_id
        )
      order by batting_order asc
      limit 1
    ),
    (select id from public.game_opponent_lineup where game_id = p_game_id order by batting_order asc limit 1)
  );
$$;

revoke execute on function public.next_opponent_lineup_batter(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 3. set_opponent_lineup: replace the whole opponent batting order. Locks
-- games FIRST, before any game_opponent_lineup write, same
-- corruption-prevention reason as set_lineup. p_entries is a jsonb array of
-- {display_name, jersey_number} objects -- free text, not roster-validated.
-- ---------------------------------------------------------------------------
create or replace function public.set_opponent_lineup(p_game_id uuid, p_entries jsonb)
returns setof public.game_opponent_lineup
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_first_id uuid;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'LINEUP_REQUIRES_PLAYERS';
  end if;

  if exists (select 1 from jsonb_array_elements(p_entries) e where jsonb_typeof(e) <> 'object') then
    raise exception 'INVALID_PLAYER_SELECTION';
  end if;

  select status into v_status from public.games where id = p_game_id for update;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  delete from public.game_opponent_lineup where game_id = p_game_id;

  insert into public.game_opponent_lineup (game_id, batting_order, display_name, jersey_number)
  select p_game_id, ord, nullif(trim(entry->>'display_name'), ''), nullif(trim(entry->>'jersey_number'), '')
  from jsonb_array_elements(p_entries) with ordinality as t(entry, ord);

  select id into v_first_id from public.game_opponent_lineup where game_id = p_game_id order by batting_order asc limit 1;
  update public.games set current_opponent_batter_id = v_first_id where id = p_game_id;

  return query select * from public.game_opponent_lineup where game_id = p_game_id order by batting_order;
end;
$$;

revoke execute on function public.set_opponent_lineup(uuid, jsonb) from public;
grant execute on function public.set_opponent_lineup(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. advance_opponent_batter: manual "next batter" override, mirrors
-- advance_batter.
-- ---------------------------------------------------------------------------
create or replace function public.advance_opponent_batter(p_game_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_current uuid;
  v_next uuid;
  v_status public.game_status;
  v_game public.games;
begin
  select e.team_id into v_team_id from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  if not exists (select 1 from public.game_opponent_lineup where game_id = p_game_id) then
    raise exception 'LINEUP_EMPTY';
  end if;

  select current_opponent_batter_id, status into v_current, v_status from public.games where id = p_game_id for update;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_next := public.next_opponent_lineup_batter(p_game_id, v_current);
  update public.games set current_opponent_batter_id = v_next where id = p_game_id returning * into v_game;
  return v_game;
end;
$$;

revoke execute on function public.advance_opponent_batter(uuid) from public;
grant execute on function public.advance_opponent_batter(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. set_opponent_pitcher: simple setter, free text, no lock needed.
-- ---------------------------------------------------------------------------
create or replace function public.set_opponent_pitcher(p_game_id uuid, p_name text, p_number text)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_status public.game_status;
  v_game public.games;
begin
  select e.team_id, g.status into v_team_id, v_status from public.games g join public.events e on e.id = g.event_id where g.id = p_game_id;
  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  update public.games
    set opponent_pitcher_name = nullif(trim(p_name), ''), opponent_pitcher_number = nullif(trim(p_number), '')
    where id = p_game_id
    returning * into v_game;
  return v_game;
end;
$$;

revoke execute on function public.set_opponent_pitcher(uuid, text, text) from public;
grant execute on function public.set_opponent_pitcher(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. record_count_event: body-only edit, same (uuid, text, int) signature.
-- Makes the auto-advance block symmetric across both sides -- exhaustive and
-- mutually exclusive across all four (half, home_or_away) combinations.
-- ---------------------------------------------------------------------------
create or replace function public.record_count_event(
  p_game_id uuid,
  p_event_type text,
  p_delta int default 1
) returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_game public.games;
  v_team_id uuid;
  v_balls int;
  v_strikes int;
  v_outs int;
  v_inning int;
  v_half text;
  v_half_at_pa_start text;
  v_status public.game_status;
  v_home_or_away text;
  v_current_batter uuid;
  v_next_batter uuid;
  v_current_opponent_batter uuid;
  v_next_opponent_batter uuid;
  v_pa_ended boolean := false;
begin
  select e.team_id into v_team_id
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_event_type not in ('ball', 'strike', 'out') then raise exception 'INVALID_COUNT_EVENT'; end if;
  if p_delta is distinct from 1 and p_delta is distinct from -1 then
    raise exception 'INVALID_COUNT_DELTA';
  end if;

  select balls, strikes, outs, current_inning, inning_half, status, home_or_away,
         current_batter_player_id, current_opponent_batter_id
    into v_balls, v_strikes, v_outs, v_inning, v_half, v_status, v_home_or_away,
         v_current_batter, v_current_opponent_batter
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  v_half_at_pa_start := v_half;
  v_next_batter := v_current_batter;
  v_next_opponent_batter := v_current_opponent_batter;

  if p_delta = 1 then
    if p_event_type = 'ball' then
      v_balls := v_balls + 1;
      if v_balls >= 4 then v_balls := 0; v_strikes := 0; v_pa_ended := true; end if;
    elsif p_event_type = 'strike' then
      v_strikes := v_strikes + 1;
      if v_strikes >= 3 then v_strikes := 0; v_balls := 0; v_outs := v_outs + 1; v_pa_ended := true; end if;
    else -- 'out'
      v_balls := 0; v_strikes := 0; v_outs := v_outs + 1; v_pa_ended := true;
    end if;

    if v_outs >= 3 then
      v_outs := 0;
      if v_half = 'top' then v_half := 'bottom';
      else v_half := 'top'; v_inning := v_inning + 1;
      end if;
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
  else -- p_delta = -1: plain correction, no threshold side effects, no batter change
    if p_event_type = 'ball' then v_balls := greatest(v_balls - 1, 0);
    elsif p_event_type = 'strike' then v_strikes := greatest(v_strikes - 1, 0);
    else v_outs := greatest(v_outs - 1, 0);
    end if;
  end if;

  update public.games
    set balls = v_balls, strikes = v_strikes, outs = v_outs,
        current_inning = v_inning, inning_half = v_half, status = 'live',
        current_batter_player_id = v_next_batter,
        current_opponent_batter_id = v_next_opponent_batter
    where id = p_game_id
    returning * into v_game;

  return v_game;
end;
$$;
