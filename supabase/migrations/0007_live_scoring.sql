-- ============================================================================
-- LigaFam — Live game scoring (Phase 3)
--
-- Adds outs/balls/strikes to the score bug, closes a direct-write RLS gap
-- on `games` (mirrors the RPC-only pattern already used for
-- game_score_events), and adds start_game/finalize_game/record_count_event
-- RPCs alongside a hardened record_score_event. Enables Realtime on `games`
-- so family/fan viewers get live updates with no polling.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. New columns. Bounds are tight (never the "3rd out"/"4th ball" value)
-- because the RPCs below always reset in PL/pgSQL before the single UPDATE
-- persists -- the boundary value is only ever a transient local variable.
-- ---------------------------------------------------------------------------
alter table public.games
  add column outs int not null default 0 check (outs between 0 and 2),
  add column balls int not null default 0 check (balls between 0 and 3),
  add column strikes int not null default 0 check (strikes between 0 and 2);

-- ---------------------------------------------------------------------------
-- 2. Close the direct-write RLS gap on `games`. game_score_events already
-- has zero write policies by design ("RPC-only, SECURITY DEFINER bypasses
-- RLS regardless"); `games` had a FOR ALL admin policy that let PostgREST
-- write directly, bypassing the RPCs entirely. Confirmed via grep that
-- nothing in the app or other migrations writes to `games` directly, so
-- this is safe to drop.
-- ---------------------------------------------------------------------------
drop policy "games: admins write" on public.games;

-- ---------------------------------------------------------------------------
-- 3. record_score_event: signature change (drops p_inning/p_inning_half --
-- the function now reads current inning/half from the game's own row
-- instead of trusting client-supplied values, avoiding staleness across
-- devices). Same drop-then-replace pattern already proven safe in
-- 0006_team_search.sql -- CREATE OR REPLACE does not replace a function
-- whose parameter TYPE signature changed, it silently creates a duplicate
-- overload instead, so the old 6-arg signature must be dropped explicitly.
-- Nothing in the app calls the old signature yet (confirmed via grep), so
-- this is safe. Also adds a FOR UPDATE lock + finalized-game guard so a
-- stray tap after finalize can't silently flip status back to 'live'.
-- ---------------------------------------------------------------------------
drop function if exists public.record_score_event(uuid, int, text, int, text, text);

create or replace function public.record_score_event(
  p_game_id uuid,
  p_runs int,
  p_scoring_team text,
  p_note text default null
) returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_game public.games;
  v_team_id uuid;
  v_inning int;
  v_half text;
  v_status public.game_status;
begin
  select e.team_id into v_team_id
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_scoring_team not in ('us', 'opponent') then raise exception 'INVALID_SCORING_TEAM'; end if;

  select current_inning, inning_half, status into v_inning, v_half, v_status
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  insert into public.game_score_events (game_id, inning, inning_half, runs_scored, scoring_team, note, created_by)
  values (p_game_id, v_inning, v_half, p_runs, p_scoring_team, p_note, auth.uid());

  if p_scoring_team = 'us' then
    update public.games set our_score = our_score + p_runs, status = 'live'
      where id = p_game_id returning * into v_game;
  else
    update public.games set opponent_score = opponent_score + p_runs, status = 'live'
      where id = p_game_id returning * into v_game;
  end if;

  return v_game;
end;
$$;

revoke execute on function public.record_score_event(uuid, int, text, text) from public;
grant execute on function public.record_score_event(uuid, int, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. record_count_event: new sibling RPC for ball/strike/out. Uses
-- `for update` to lock the row for the duration of the read-compute-write,
-- so two co-admins scoring the same live game from separate devices can't
-- lose an update to each other (the second call blocks until the first
-- commits, then reads the now-current state instead of a stale snapshot).
-- ---------------------------------------------------------------------------
create or replace function public.record_count_event(
  p_game_id uuid,
  p_event_type text
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
  v_status public.game_status;
begin
  select e.team_id into v_team_id
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_event_type not in ('ball', 'strike', 'out') then raise exception 'INVALID_COUNT_EVENT'; end if;

  select balls, strikes, outs, current_inning, inning_half, status
    into v_balls, v_strikes, v_outs, v_inning, v_half, v_status
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  if p_event_type = 'ball' then
    v_balls := v_balls + 1;
    if v_balls >= 4 then
      v_balls := 0;
      v_strikes := 0;
    end if;
  elsif p_event_type = 'strike' then
    v_strikes := v_strikes + 1;
    if v_strikes >= 3 then
      v_strikes := 0;
      v_balls := 0;
      v_outs := v_outs + 1;
    end if;
  else -- 'out'
    v_balls := 0;
    v_strikes := 0;
    v_outs := v_outs + 1;
  end if;

  if v_outs >= 3 then
    v_outs := 0;
    if v_half = 'top' then
      v_half := 'bottom';
    else
      v_half := 'top';
      v_inning := v_inning + 1;
    end if;
  end if;

  update public.games
    set balls = v_balls, strikes = v_strikes, outs = v_outs,
        current_inning = v_inning, inning_half = v_half, status = 'live'
    where id = p_game_id
    returning * into v_game;

  return v_game;
end;
$$;

revoke execute on function public.record_count_event(uuid, text) from public;
grant execute on function public.record_count_event(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. start_game / finalize_game. start_game uses `on conflict (event_id)
-- do nothing` so two admins tapping "Iniciar partido" near-simultaneously
-- get a clean idempotent result instead of a raw duplicate-key error.
-- finalize_game's `where ... and status <> 'final' ... if v_game.id is null
-- then raise` is an atomic, lock-free guard against double-finalizing.
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

  return v_game;
end;
$$;

revoke execute on function public.start_game(uuid) from public;
grant execute on function public.start_game(uuid) to authenticated;

create or replace function public.finalize_game(p_game_id uuid)
returns public.games
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_game public.games;
begin
  select e.team_id into v_team_id
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;

  update public.games
    set status = 'final', ended_at = now()
    where id = p_game_id and status <> 'final'
    returning * into v_game;

  if v_game.id is null then
    raise exception 'GAME_ALREADY_FINAL';
  end if;

  return v_game;
end;
$$;

revoke execute on function public.finalize_game(uuid) from public;
grant execute on function public.finalize_game(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Enable Realtime for `games` only -- no UI in this pass renders a
-- play-by-play feed, so game_score_events doesn't need to stream. Realtime
-- respects the existing "games: members read" RLS policy automatically.
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.games;
