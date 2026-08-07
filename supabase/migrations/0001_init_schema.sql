-- ============================================================================
-- LigaFam — Initial schema
-- Roster model: persists at team level, activated per season via season_rosters
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Profiles (extends auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text unique,
  preferred_locale text not null default 'es' check (preferred_locale in ('es','en')),
  avatar_url text,
  created_at timestamptz not null default now()
);

comment on table public.profiles is 'One row per authenticated user, extends auth.users.';

-- Auto-create a profile row when a new auth user signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.phone
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Teams & Seasons
-- ---------------------------------------------------------------------------
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sport text not null default 'baseball',
  age_group text,
  logo_url text,
  invite_code text unique not null default substr(md5(random()::text), 0, 8),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  name text not null,
  year int not null,
  starts_on date,
  ends_on date,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create index idx_seasons_team on public.seasons(team_id);

-- ---------------------------------------------------------------------------
-- Membership
-- ---------------------------------------------------------------------------
create type public.team_role as enum ('admin', 'family', 'fan');
create type public.member_status as enum ('pending', 'approved', 'rejected', 'removed');

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.team_role not null,
  status public.member_status not null default 'pending',
  requested_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  unique (team_id, user_id)
);

create index idx_team_members_team on public.team_members(team_id);
create index idx_team_members_user on public.team_members(user_id);

-- Enforce max 3 approved admins per team
create or replace function public.enforce_max_admins()
returns trigger as $$
begin
  if new.role = 'admin' and new.status = 'approved' then
    if (
      select count(*) from public.team_members
      where team_id = new.team_id
        and role = 'admin'
        and status = 'approved'
        and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) >= 3 then
      raise exception 'A team can have a maximum of 3 admins';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_max_admins
  before insert or update on public.team_members
  for each row execute function public.enforce_max_admins();

-- ---------------------------------------------------------------------------
-- Roster (persists at team level) + per-season activation
-- ---------------------------------------------------------------------------
create table public.players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  first_name text not null,
  last_name text not null,
  jersey_number text,
  primary_position text,
  birth_year int,
  created_at timestamptz not null default now()
);

create index idx_players_team on public.players(team_id);

create table public.season_rosters (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  active boolean not null default true,
  unique (season_id, player_id)
);

-- Links a family team_member to the specific kid(s) they represent
create table public.family_links (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid not null references public.team_members(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  unique (team_member_id, player_id)
);

create index idx_family_links_member on public.family_links(team_member_id);
create index idx_family_links_player on public.family_links(player_id);

-- ---------------------------------------------------------------------------
-- Events (games / practices) + RSVP + snacks
-- ---------------------------------------------------------------------------
create type public.event_type as enum ('game', 'practice', 'other');

create table public.events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  season_id uuid references public.seasons(id) on delete set null,
  type public.event_type not null default 'game',
  title text,
  opponent_name text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index idx_events_team on public.events(team_id);
create index idx_events_starts_at on public.events(starts_at);

create type public.rsvp_status as enum ('yes', 'no', 'maybe', 'no_response');

create table public.event_rsvps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  responded_by uuid references public.profiles(id),
  status public.rsvp_status not null default 'no_response',
  updated_at timestamptz not null default now(),
  unique (event_id, player_id)
);

create index idx_rsvps_event on public.event_rsvps(event_id);

-- Auto-create a no_response RSVP row for every active roster player when an event is created
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
$$ language plpgsql;

create trigger trg_seed_rsvps
  after insert on public.events
  for each row execute function public.seed_event_rsvps();

create table public.snack_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  family_link_id uuid references public.family_links(id) on delete set null,
  item text,
  confirmed boolean not null default false,
  created_at timestamptz not null default now()
);

create index idx_snacks_event on public.snack_assignments(event_id);

-- ---------------------------------------------------------------------------
-- Games & live scoring
-- ---------------------------------------------------------------------------
create type public.game_status as enum ('scheduled', 'live', 'final', 'postponed', 'canceled');

create table public.games (
  id uuid primary key default gen_random_uuid(),
  event_id uuid unique not null references public.events(id) on delete cascade,
  status public.game_status not null default 'scheduled',
  home_or_away text check (home_or_away in ('home', 'away')),
  our_score int not null default 0,
  opponent_score int not null default 0,
  current_inning int not null default 1,
  inning_half text check (inning_half in ('top', 'bottom')) default 'top',
  started_at timestamptz,
  ended_at timestamptz
);

create table public.game_score_events (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  inning int not null,
  inning_half text not null check (inning_half in ('top', 'bottom')),
  runs_scored int not null default 0,
  scoring_team text not null check (scoring_team in ('us', 'opponent')),
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index idx_score_events_game on public.game_score_events(game_id);

-- Atomic score update: insert log row + update cached totals in one transaction
create or replace function public.record_score_event(
  p_game_id uuid,
  p_inning int,
  p_inning_half text,
  p_runs int,
  p_scoring_team text,
  p_note text default null
) returns public.games as $$
declare
  v_game public.games;
begin
  insert into public.game_score_events (game_id, inning, inning_half, runs_scored, scoring_team, note, created_by)
  values (p_game_id, p_inning, p_inning_half, p_runs, p_scoring_team, p_note, auth.uid());

  if p_scoring_team = 'us' then
    update public.games
      set our_score = our_score + p_runs,
          current_inning = p_inning,
          inning_half = p_inning_half,
          status = 'live'
      where id = p_game_id
      returning * into v_game;
  else
    update public.games
      set opponent_score = opponent_score + p_runs,
          current_inning = p_inning,
          inning_half = p_inning_half,
          status = 'live'
      where id = p_game_id
      returning * into v_game;
  end if;

  return v_game;
end;
$$ language plpgsql security definer;

create table public.game_lineup (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  batting_order int,
  position text,
  unique (game_id, player_id)
);

-- ---------------------------------------------------------------------------
-- Chat (family + admin only, enforced at RLS layer)
-- ---------------------------------------------------------------------------
create table public.team_messages (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  sender_id uuid references public.profiles(id),
  body text not null,
  created_at timestamptz not null default now()
);

create index idx_messages_team on public.team_messages(team_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Season record summary (recalculated on game finalize)
-- ---------------------------------------------------------------------------
create table public.team_season_records (
  season_id uuid primary key references public.seasons(id) on delete cascade,
  wins int not null default 0,
  losses int not null default 0,
  ties int not null default 0,
  updated_at timestamptz not null default now()
);

create or replace function public.recalculate_season_record(p_season_id uuid)
returns void as $$
begin
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
$$ language plpgsql security definer;

create or replace function public.on_game_finalized()
returns trigger as $$
declare
  v_season_id uuid;
begin
  if new.status = 'final' and (old.status is distinct from 'final') then
    select season_id into v_season_id from public.events where id = new.event_id;
    if v_season_id is not null then
      perform public.recalculate_season_record(v_season_id);
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_game_finalized
  after update on public.games
  for each row execute function public.on_game_finalized();

-- ---------------------------------------------------------------------------
-- Join requests view (convenience — team_members WHERE status = 'pending')
-- ---------------------------------------------------------------------------
create view public.pending_join_requests as
  select tm.*, p.full_name, p.phone
  from public.team_members tm
  join public.profiles p on p.id = tm.user_id
  where tm.status = 'pending';
