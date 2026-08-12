-- ============================================================================
-- LigaFam — Ball/strike/out correction (+/- buttons)
--
-- Lets an admin correct a misclicked ball/strike/out without resetting the
-- game. Adds p_delta to record_count_event (default 1, so the existing +1
-- call site keeps working unchanged); -1 is a plain decrement of that one
-- counter, floored at 0, with none of the +1 path's threshold side effects
-- (no walk, no strikeout-out, no inning advance, other counters untouched).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Signature change (uuid, text) -> (uuid, text, int) requires the explicit
-- drop-then-recreate pattern already used in 0006/0007 -- CREATE OR REPLACE
-- does not replace a function whose parameter TYPES changed, it creates a
-- silently ambiguous duplicate overload instead.
-- ---------------------------------------------------------------------------
drop function if exists public.record_count_event(uuid, text);

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
  v_status public.game_status;
begin
  select e.team_id into v_team_id
  from public.games g join public.events e on e.id = g.event_id
  where g.id = p_game_id;

  if v_team_id is null then raise exception 'GAME_NOT_FOUND'; end if;
  if not public.is_team_admin(v_team_id) then raise exception 'NOT_AUTHORIZED'; end if;
  if p_event_type not in ('ball', 'strike', 'out') then raise exception 'INVALID_COUNT_EVENT'; end if;

  -- IS DISTINCT FROM is NULL-safe -- plain `not in (1, -1)` would silently
  -- let an explicit p_delta: null slip past this check (NULL NOT IN (...)
  -- evaluates to NULL, which `if` treats as false) and then fall into the
  -- decrement branch below via `if p_delta = 1 then ... else`, since
  -- `NULL = 1` is also NULL/falsy -- a real, not just theoretical, gap.
  if p_delta is distinct from 1 and p_delta is distinct from -1 then
    raise exception 'INVALID_COUNT_DELTA';
  end if;

  select balls, strikes, outs, current_inning, inning_half, status
    into v_balls, v_strikes, v_outs, v_inning, v_half, v_status
  from public.games where id = p_game_id for update;

  if v_status = 'final' then raise exception 'GAME_ALREADY_FINAL'; end if;

  if p_delta = 1 then
    if p_event_type = 'ball' then
      v_balls := v_balls + 1;
      if v_balls >= 4 then v_balls := 0; v_strikes := 0; end if;
    elsif p_event_type = 'strike' then
      v_strikes := v_strikes + 1;
      if v_strikes >= 3 then v_strikes := 0; v_balls := 0; v_outs := v_outs + 1; end if;
    else -- 'out'
      v_balls := 0; v_strikes := 0; v_outs := v_outs + 1;
    end if;

    if v_outs >= 3 then
      v_outs := 0;
      if v_half = 'top' then v_half := 'bottom';
      else v_half := 'top'; v_inning := v_inning + 1;
      end if;
    end if;
  else -- p_delta = -1: plain correction, no threshold side effects, no
       -- attempt to "undo" an inning transition that already happened
    if p_event_type = 'ball' then
      v_balls := greatest(v_balls - 1, 0);
    elsif p_event_type = 'strike' then
      v_strikes := greatest(v_strikes - 1, 0);
    else
      v_outs := greatest(v_outs - 1, 0);
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

revoke execute on function public.record_count_event(uuid, text, int) from public;
grant execute on function public.record_count_event(uuid, text, int) to authenticated;
