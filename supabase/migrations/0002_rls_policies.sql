-- ============================================================================
-- LigaFam — Row Level Security policies
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
create or replace function public.is_team_admin(p_team_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id
      and user_id = auth.uid()
      and role = 'admin'
      and status = 'approved'
  );
$$ language sql security definer stable;

create or replace function public.is_approved_member(p_team_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id
      and user_id = auth.uid()
      and status = 'approved'
  );
$$ language sql security definer stable;

create or replace function public.is_approved_family(p_team_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team_id
      and user_id = auth.uid()
      and role = 'family'
      and status = 'approved'
  );
$$ language sql security definer stable;

create or replace function public.owns_player_via_family(p_player_id uuid)
returns boolean as $$
  select exists (
    select 1 from public.family_links fl
    join public.team_members tm on tm.id = fl.team_member_id
    where fl.player_id = p_player_id
      and tm.user_id = auth.uid()
      and tm.status = 'approved'
  );
$$ language sql security definer stable;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.seasons enable row level security;
alter table public.team_members enable row level security;
alter table public.players enable row level security;
alter table public.season_rosters enable row level security;
alter table public.family_links enable row level security;
alter table public.events enable row level security;
alter table public.event_rsvps enable row level security;
alter table public.snack_assignments enable row level security;
alter table public.games enable row level security;
alter table public.game_score_events enable row level security;
alter table public.game_lineup enable row level security;
alter table public.team_messages enable row level security;
alter table public.team_season_records enable row level security;

-- ---------------------------------------------------------------------------
-- profiles: users manage their own; approved teammates can view basic info
-- ---------------------------------------------------------------------------
create policy "profiles: self read/write" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

create policy "profiles: teammates can view" on public.profiles
  for select using (
    exists (
      select 1 from public.team_members tm1
      join public.team_members tm2 on tm1.team_id = tm2.team_id
      where tm1.user_id = auth.uid() and tm1.status = 'approved'
        and tm2.user_id = public.profiles.id and tm2.status = 'approved'
    )
  );

-- ---------------------------------------------------------------------------
-- teams: any authenticated user can read (needed for join/search flow);
-- only creator/admins can update
-- ---------------------------------------------------------------------------
create policy "teams: authenticated read" on public.teams
  for select using (auth.role() = 'authenticated');

create policy "teams: authenticated create" on public.teams
  for insert with check (auth.uid() is not null);

create policy "teams: admins update" on public.teams
  for update using (public.is_team_admin(id));

-- ---------------------------------------------------------------------------
-- seasons
-- ---------------------------------------------------------------------------
create policy "seasons: members read" on public.seasons
  for select using (public.is_approved_member(team_id));

create policy "seasons: admins write" on public.seasons
  for insert with check (public.is_team_admin(team_id));

create policy "seasons: admins update" on public.seasons
  for update using (public.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- team_members
-- ---------------------------------------------------------------------------
-- Anyone authenticated can create their OWN pending request (join flow)
create policy "team_members: self join request" on public.team_members
  for insert with check (user_id = auth.uid() and status = 'pending');

-- Approved members can see other approved members of their team;
-- users can always see their own row (to check their own pending status)
create policy "team_members: read own or teammates" on public.team_members
  for select using (
    user_id = auth.uid()
    or public.is_approved_member(team_id)
  );

-- Only admins can approve/reject/change roles/remove members
create policy "team_members: admins manage" on public.team_members
  for update using (public.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- players (roster)
-- ---------------------------------------------------------------------------
create policy "players: members read" on public.players
  for select using (public.is_approved_member(team_id));

create policy "players: admins write" on public.players
  for insert with check (public.is_team_admin(team_id));

create policy "players: admins update" on public.players
  for update using (public.is_team_admin(team_id));

create policy "players: admins delete" on public.players
  for delete using (public.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- season_rosters
-- ---------------------------------------------------------------------------
create policy "season_rosters: members read" on public.season_rosters
  for select using (
    exists (select 1 from public.seasons s where s.id = season_id and public.is_approved_member(s.team_id))
  );

create policy "season_rosters: admins write" on public.season_rosters
  for all using (
    exists (select 1 from public.seasons s where s.id = season_id and public.is_team_admin(s.team_id))
  );

-- ---------------------------------------------------------------------------
-- family_links — admins manage; the linked family member can read their own
-- ---------------------------------------------------------------------------
create policy "family_links: admins manage" on public.family_links
  for all using (
    exists (
      select 1 from public.team_members tm
      where tm.id = team_member_id and public.is_team_admin(tm.team_id)
    )
  );

create policy "family_links: self read" on public.family_links
  for select using (
    exists (
      select 1 from public.team_members tm
      where tm.id = team_member_id and tm.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create policy "events: members read" on public.events
  for select using (public.is_approved_member(team_id));

create policy "events: admins write" on public.events
  for insert with check (public.is_team_admin(team_id));

create policy "events: admins update" on public.events
  for update using (public.is_team_admin(team_id));

create policy "events: admins delete" on public.events
  for delete using (public.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- event_rsvps — family can only write RSVPs for players they're linked to;
-- admins can write any; everyone approved can read
-- ---------------------------------------------------------------------------
create policy "rsvps: members read" on public.event_rsvps
  for select using (
    exists (select 1 from public.events e where e.id = event_id and public.is_approved_member(e.team_id))
  );

create policy "rsvps: family write own kid" on public.event_rsvps
  for update using (public.owns_player_via_family(player_id))
  with check (public.owns_player_via_family(player_id));

create policy "rsvps: admins write any" on public.event_rsvps
  for update using (
    exists (select 1 from public.events e where e.id = event_id and public.is_team_admin(e.team_id))
  );

-- ---------------------------------------------------------------------------
-- snack_assignments
-- ---------------------------------------------------------------------------
create policy "snacks: members read" on public.snack_assignments
  for select using (
    exists (select 1 from public.events e where e.id = event_id and public.is_approved_member(e.team_id))
  );

create policy "snacks: family manage own" on public.snack_assignments
  for all using (
    exists (
      select 1 from public.family_links fl
      join public.team_members tm on tm.id = fl.team_member_id
      where fl.id = family_link_id and tm.user_id = auth.uid()
    )
  );

create policy "snacks: admins manage all" on public.snack_assignments
  for all using (
    exists (select 1 from public.events e where e.id = event_id and public.is_team_admin(e.team_id))
  );

-- ---------------------------------------------------------------------------
-- games — everyone approved reads; only admins write (via RPC ideally)
-- ---------------------------------------------------------------------------
create policy "games: members read" on public.games
  for select using (
    exists (select 1 from public.events e where e.id = event_id and public.is_approved_member(e.team_id))
  );

create policy "games: admins write" on public.games
  for all using (
    exists (select 1 from public.events e where e.id = event_id and public.is_team_admin(e.team_id))
  );

create policy "game_score_events: members read" on public.game_score_events
  for select using (
    exists (
      select 1 from public.games g
      join public.events e on e.id = g.event_id
      where g.id = game_id and public.is_approved_member(e.team_id)
    )
  );

-- Direct inserts blocked; scoring goes through record_score_event() (security definer)
-- No insert/update/delete policy defined here on purpose — clients must call the RPC.

create policy "game_lineup: members read" on public.game_lineup
  for select using (
    exists (
      select 1 from public.games g
      join public.events e on e.id = g.event_id
      where g.id = game_id and public.is_approved_member(e.team_id)
    )
  );

create policy "game_lineup: admins write" on public.game_lineup
  for all using (
    exists (
      select 1 from public.games g
      join public.events e on e.id = g.event_id
      where g.id = game_id and public.is_team_admin(e.team_id)
    )
  );

-- ---------------------------------------------------------------------------
-- team_messages — family + admins only (NOT fans)
-- ---------------------------------------------------------------------------
create policy "messages: family+admins read" on public.team_messages
  for select using (
    public.is_team_admin(team_id) or public.is_approved_family(team_id)
  );

create policy "messages: family+admins write" on public.team_messages
  for insert with check (
    sender_id = auth.uid()
    and (public.is_team_admin(team_id) or public.is_approved_family(team_id))
  );

-- ---------------------------------------------------------------------------
-- team_season_records
-- ---------------------------------------------------------------------------
create policy "records: members read" on public.team_season_records
  for select using (
    exists (select 1 from public.seasons s where s.id = season_id and public.is_approved_member(s.team_id))
  );
