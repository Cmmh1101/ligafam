-- ============================================================================
-- LigaFam — Recalculate season record on event deletion
--
-- The bug: team_season_records is only ever refreshed by trg_game_finalized
-- (fires AFTER UPDATE ON games, on the transition into status = 'final').
-- There's no counterpart for deletion, so when an admin deletes an event
-- whose game was already finalized (deleteEventAction does a plain
-- `DELETE FROM events ...`, which cascades to `games` via
-- games.event_id ... on delete cascade), the aggregate keeps counting a
-- game that no longer exists until someone manually re-runs
-- recalculate_season_record.
--
-- Why a CONSTRAINT TRIGGER (deferred), not a plain AFTER DELETE trigger:
-- ON DELETE CASCADE for games.event_id -> events(id) is itself implemented
-- as an internal AFTER DELETE FOR EACH ROW trigger on `events` (the
-- referenced table), not something that runs "before" or "outside" the
-- trigger system. A plain `AFTER DELETE ON events FOR EACH ROW` trigger of
-- ours would be queued at the SAME firing point as that internal cascade
-- trigger, and same-timing AFTER ROW triggers on the same relation/event
-- fire in alphabetical order BY TRIGGER NAME -- the internal trigger's name
-- (RI_ConstraintTrigger_...) is system-generated, so whether our SELECT
-- ... FROM games would see the games row already gone would depend on a
-- string comparison we don't control (collation-, version-, and
-- constraint-oid-dependent). A DEFERRABLE INITIALLY DEFERRED constraint
-- trigger sidesteps this: it doesn't fire at end-of-statement at all, it
-- fires at COMMIT, by which point every cascade effect of the whole
-- transaction -- including the games cascade-delete -- has already
-- happened, regardless of alphabetical ordering. deleteEventAction issues
-- a single auto-committing DELETE with no explicit BEGIN/COMMIT block, so
-- "fires at commit" and "fires immediately after" are indistinguishable
-- for every real caller in this codebase today.
--
-- recalculate_season_record now no-ops if the season is gone (or
-- p_season_id is null) instead of pushing that guard into the trigger --
-- this also protects the whole-team-delete path, where `teams` cascades to
-- BOTH `seasons` and `events` independently via two separate
-- `on delete cascade` FKs. If the seasons-cascade happens to run first,
-- team_season_records is already gone by the time this trigger would
-- otherwise try to INSERT a row referencing a season_id that no longer
-- exists in `seasons`, which would violate the FK and abort the whole
-- team-delete transaction. Because our trigger is itself deferred to
-- commit time, this guard sees the fully-cascaded end state no matter
-- which of the two sibling cascades Postgres happened to run first --
-- and putting the guard inside the function (rather than only in this
-- trigger) means any future caller gets the same protection for free.
-- ============================================================================

create or replace function public.recalculate_season_record(p_season_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_season_id is null or not exists (select 1 from public.seasons where id = p_season_id) then
    return;
  end if;

  insert into public.team_season_records (season_id, wins, losses, ties, updated_at)
  select
    p_season_id,
    count(*) filter (where g.our_score > g.opponent_score),
    count(*) filter (where g.our_score < g.opponent_score),
    count(*) filter (where g.our_score = g.opponent_score),
    now()
  from public.games g
  join public.events e on e.id = g.event_id
  where e.season_id = p_season_id and g.status = 'final'
  on conflict (season_id) do update
    set wins = excluded.wins, losses = excluded.losses, ties = excluded.ties, updated_at = now();
end;
$$;

-- Opportunistic hardening while already touching this function: every
-- other SECURITY DEFINER function in this codebase revokes public
-- execute, but this one never did -- meaning any authenticated client
-- could call it directly for an arbitrary season_id today, bypassing
-- membership checks (recalculation is deterministic/read-derived so not
-- exploitable for data corruption, but there's no reason to leave it
-- open). Internal-only, no grant, matching next_opponent_lineup_batter's
-- pattern in 0010.
revoke execute on function public.recalculate_season_record(uuid) from public;

create or replace function public.on_event_deleted()
returns trigger
language plpgsql as $$
begin
  perform public.recalculate_season_record(OLD.season_id);
  return OLD;
end;
$$;

drop trigger if exists trg_event_deleted_recalc on public.events;

create constraint trigger trg_event_deleted_recalc
  after delete on public.events
  deferrable initially deferred
  for each row execute function public.on_event_deleted();
