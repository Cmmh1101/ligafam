-- ============================================================================
-- LigaFam — Phase 2 prep: event RSVP seeding fixes + implicit season mgmt
--
-- Three pre-existing gaps found while designing Calendar & RSVP, fixed here:
--   1. seed_event_rsvps() (0001) is plain SECURITY INVOKER, but there was no
--      INSERT policy on event_rsvps at all -- creating an event silently
--      seeded zero RSVP rows.
--   2. Phase 1 never wired up seasons: create_team() creates no season, and
--      adding a roster player creates no season_rosters row. Even after
--      fixing #1, the seed trigger (keyed off season_rosters) would still
--      insert nothing. Fixed by auto-managing one implicit "current season"
--      per team, invisible to the user -- preserves the season_rosters
--      model architecture-plan.md §3.3 chose for future season stats,
--      instead of bypassing it.
--   3. snack_assignments' family-write policy never checked
--      tm.status = 'approved', unlike the equivalent RSVP check -- a still-
--      pending family applicant could read/write snack signups before an
--      admin ever approved them (family_links rows exist from request time,
--      not approval time).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Fix #1: seed_event_rsvps() needs to bypass RLS for its own system-mediated
-- insert, same pattern as create_team/approve_join_request in 0003.
-- ---------------------------------------------------------------------------
create or replace function public.seed_event_rsvps()
returns trigger as $$
begin
  if new.type = 'game' or new.type = 'practice' then
    insert into public.event_rsvps (event_id, player_id, status)
    select new.id, sr.player_id, 'no_response'
    from public.season_rosters sr
    where sr.season_id = new.season_id and sr.active = true
    on conflict (event_id, player_id) do nothing;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

-- ---------------------------------------------------------------------------
-- Fix #2: auto-manage one implicit "current season" per team.
--
-- seed_default_season is security definer: it fires inside create_team()
-- (already security definer) so it doesn't strictly need it there, but
-- "teams: authenticated create" is a live policy letting a direct client
-- insert bypass create_team() entirely -- if that path is ever exercised, a
-- non-definer trigger would fail confusingly. Costs nothing to mark it
-- definer now.
--
-- seed_season_roster does NOT get security definer: it fires from a direct,
-- non-RPC `players` insert already gated by "players: admins write", and
-- "season_rosters: admins write" (FOR ALL, USING-only -- Postgres reuses
-- that as WITH CHECK) already permits the same admin to write
-- season_rosters for their own team. Least privilege: leave it at the real
-- invoker's level.
-- ---------------------------------------------------------------------------
create or replace function public.seed_default_season()
returns trigger as $$
begin
  insert into public.seasons (team_id, name, year, is_active)
  values (new.id, 'Temporada actual', extract(year from now())::int, true);
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_seed_default_season
  after insert on public.teams
  for each row execute function public.seed_default_season();

create or replace function public.seed_season_roster()
returns trigger as $$
declare
  v_season_id uuid;
begin
  select id into v_season_id from public.seasons
    where team_id = new.team_id and is_active = true
    order by created_at desc limit 1;

  if v_season_id is not null then
    insert into public.season_rosters (season_id, player_id, active)
    values (v_season_id, new.id, true)
    on conflict (season_id, player_id) do nothing;
  end if;

  return new;
end;
$$ language plpgsql set search_path = public;

create trigger trg_seed_season_roster
  after insert on public.players
  for each row execute function public.seed_season_roster();

-- Defensive: nothing else enforces "at most one active season per team" --
-- seasons: admins write allows a direct client insert with no RPC guard.
create unique index one_active_season_per_team
  on public.seasons(team_id) where is_active;

-- Backfill: teams/players created before this migration have no season /
-- season_rosters rows yet.
insert into public.seasons (team_id, name, year, is_active)
select t.id, 'Temporada actual', extract(year from now())::int, true
from public.teams t
where not exists (
  select 1 from public.seasons s where s.team_id = t.id and s.is_active = true
);

insert into public.season_rosters (season_id, player_id, active)
select s.id, p.id, true
from public.players p
join public.seasons s on s.team_id = p.team_id and s.is_active = true
on conflict (season_id, player_id) do nothing;

-- ---------------------------------------------------------------------------
-- event_rsvps INSERT policies -- mirror the existing UPDATE policies.
-- Needed for a player added to the roster AFTER an event already exists (no
-- seeded row yet); the app's RSVP toggle upserts, so this is what makes
-- that upsert's insert path legal.
-- ---------------------------------------------------------------------------
create policy "rsvps: family insert own kid" on public.event_rsvps
  for insert with check (public.owns_player_via_family(player_id));

create policy "rsvps: admins insert any" on public.event_rsvps
  for insert with check (
    exists (select 1 from public.events e where e.id = event_id and public.is_team_admin(e.team_id))
  );

-- ---------------------------------------------------------------------------
-- Fix #3: close the pending-applicant snack-write gap.
-- ---------------------------------------------------------------------------
drop policy "snacks: family manage own" on public.snack_assignments;

create policy "snacks: family manage own" on public.snack_assignments
  for all using (
    exists (
      select 1 from public.family_links fl
      join public.team_members tm on tm.id = fl.team_member_id
      where fl.id = family_link_id and tm.user_id = auth.uid() and tm.status = 'approved'
    )
  );
