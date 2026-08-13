-- ============================================================================
-- LigaFam — Run removal (-1 correction, mirrors record_count_event's p_delta)
--
-- Floors our_score/opponent_score at 0 so a misclicked "+1 carrera" can be
-- corrected with a same-signature "-1" call without ever driving a score
-- negative. Body-only change (same (uuid, int, text, text) signature as
-- 0007_live_scoring.sql) -- CREATE OR REPLACE is safe here since no
-- parameter type changed, unlike the drop-then-recreate needed in 0007 when
-- p_inning/p_inning_half were dropped from the signature entirely.
--
-- Not restricted to p_runs in (1, -1) the way record_count_event's p_delta
-- is -- p_runs stays a general signed int (a future bulk-correction UI could
-- still pass e.g. p_runs: -3 for a multi-run overcount in one call). The
-- clamp is what matters: greatest(new_total, 0), regardless of magnitude.
--
-- Safe with respect to season-record finalization: trg_game_finalized only
-- fires on the transition to status = 'final' (old.status is distinct from
-- 'final'), and recalculate_season_record() re-aggregates our_score/
-- opponent_score fresh from `games` at that moment -- it holds no cached
-- pre-correction value. A run removed before finalize is simply reflected
-- in whatever score exists when finalize_game() runs; a correction attempted
-- after finalize is already blocked by the existing v_status = 'final' guard
-- below, same as every other live-scoring RPC.
-- ============================================================================
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
    update public.games set our_score = greatest(our_score + p_runs, 0), status = 'live'
      where id = p_game_id returning * into v_game;
  else
    update public.games set opponent_score = greatest(opponent_score + p_runs, 0), status = 'live'
      where id = p_game_id returning * into v_game;
  end if;

  return v_game;
end;
$$;

-- No revoke/grant needed -- signature unchanged, 0007_live_scoring.sql's
-- grant to authenticated still applies to this function object.
