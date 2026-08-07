# Sports Team App — Architecture & MVP Plan
### (Working name: "LigaFam" — replace with real name later)

---

## 1. Product Summary

A bilingual (ES default / EN toggle) team & season tracker for youth/amateur sports, starting with baseball. Modeled conceptually on GameChanger, targeted at the Hispanic market.

Three roles per team:
- **Admin** (max 3 per team): full team management, roster, scheduling, live scoring.
- **Family member**: linked to a specific roster player (their kid). RSVP, chat, snack planning, calendar, scores.
- **Fan**: read-only follower. Record, calendar, live/final scores.

MVP = **Next.js PWA + Supabase**, web only, offline-capable, baseball only. React Native app is Phase 2, built on the same Supabase schema and shared TypeScript logic.

---

## 2. Tech Stack & Repo Strategy

```
/apps
  /web          → Next.js 15 (App Router), PWA via Serwist
  /mobile       → Expo / React Native (Phase 2)
/packages
  /shared-types → Generated Supabase types + zod schemas
  /domain       → Pure TS: scoring rules, RSVP logic, permission checks, i18n keys
  /ui           → (later) cross-platform primitives if using e.g. Tamagui
/supabase
  /migrations
  /functions    → Edge Functions (notifications, scheduled jobs)
```

**Why a monorepo now even though mobile is later:** the roster/permissions/scoring logic should never be written twice. Next.js and RN both import `@app/domain`. This is the single highest-leverage decision for avoiding a rewrite in Phase 2.

| Layer | Choice | Notes |
|---|---|---|
| Web framework | Next.js 15, App Router | Server Components for data-heavy read views, Client Components for realtime widgets |
| PWA / offline | Serwist (maintained fork of next-pwa/Workbox) | Service worker + IndexedDB cache |
| Local persistence | Dexie.js (IndexedDB wrapper) | Cache team/roster/calendar for offline read; outbox queue for offline writes |
| Backend | Supabase (Postgres, Auth, Realtime, Storage, Edge Functions) | RLS-first security model |
| Auth | Supabase Auth — phone OTP (primary) + email fallback + Google | Phone-first matters for this audience |
| Realtime | Supabase Realtime (Postgres CDC + Broadcast channels) | Live scoring & chat |
| i18n | `next-intl` | Locale in URL or user preference; toggle stored per-user |
| Push notifications | Web Push (VAPID) via Edge Function + `web-push` lib | RN will use Expo push later |
| Hosting | Vercel (web) | Supabase hosted or self-hosted later if cost matters |

---

## 3. Data Model

### 3.1 Core entities (ERD in words)

```
organizations (optional in MVP — could hardcode "1 org = league" or skip entirely)
  └── teams
        ├── seasons
        ├── team_members (user_id, role, status)
        │     └── family_links (team_member_id → player_id)  [only for role=family]
        ├── players (roster, belongs to a season or persists across seasons — see 3.3)
        ├── events (games/practices, belongs to a season)
        │     ├── event_rsvps (per family member, per event)
        │     ├── snack_assignments (per event)
        │     └── games (1:1 with event when event.type = 'game')
        │           ├── game_innings / game_score_log (realtime scoring)
        │           └── game_lineup (player_id → position, per game)
        ├── join_requests (pending approvals)
        ├── team_messages (chat)
        └── notifications (fan-out table or just push log)
```

### 3.2 Key tables (DDL sketch)

```sql
-- USERS handled by Supabase auth.users; we extend with a profile table
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  preferred_locale text not null default 'es' check (preferred_locale in ('es','en')),
  avatar_url text,
  created_at timestamptz default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sport text not null default 'baseball',
  age_group text,               -- e.g. "10U"
  logo_url text,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  name text not null,           -- e.g. "Spring 2026"
  year int not null,
  starts_on date,
  ends_on date,
  is_active boolean default true
);

create type team_role as enum ('admin','family','fan');
create type member_status as enum ('pending','approved','rejected','removed');

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  role team_role not null,
  status member_status not null default 'pending',
  requested_at timestamptz default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  unique (team_id, user_id)
);

-- Enforce max 3 approved admins per team via trigger (see §3.4)

create table public.players (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  season_id uuid references public.seasons(id),  -- nullable if roster persists across seasons
  first_name text not null,
  last_name text not null,
  jersey_number text,
  primary_position text,
  birth_year int,
  active boolean default true,
  created_at timestamptz default now()
);

-- Links a family team_member to the specific kid(s) they represent
create table public.family_links (
  id uuid primary key default gen_random_uuid(),
  team_member_id uuid references public.team_members(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  unique (team_member_id, player_id)
);

create type event_type as enum ('game','practice','other');

create table public.events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  season_id uuid references public.seasons(id),
  type event_type not null default 'game',
  title text,
  opponent_name text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create type rsvp_status as enum ('yes','no','maybe','no_response');

create table public.event_rsvps (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,   -- RSVP is per-kid, not per-user
  responded_by uuid references public.profiles(id),
  status rsvp_status not null default 'no_response',
  updated_at timestamptz default now(),
  unique (event_id, player_id)
);

create table public.snack_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  family_link_id uuid references public.family_links(id),  -- who's assigned
  item text,               -- "drinks", "snacks", free text
  confirmed boolean default false,
  created_at timestamptz default now()
);

create type game_status as enum ('scheduled','live','final','postponed','canceled');

create table public.games (
  id uuid primary key default gen_random_uuid(),
  event_id uuid unique references public.events(id) on delete cascade,
  status game_status not null default 'scheduled',
  home_or_away text check (home_or_away in ('home','away')),
  our_score int not null default 0,
  opponent_score int not null default 0,
  current_inning int default 1,
  inning_half text check (inning_half in ('top','bottom')),
  started_at timestamptz,
  ended_at timestamptz
);

-- Append-only log = source of truth; our_score/opponent_score are derived/cached
create table public.game_score_events (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references public.games(id) on delete cascade,
  inning int not null,
  inning_half text not null,
  runs_scored int not null default 0,   -- for the team scoring
  scoring_team text check (scoring_team in ('us','opponent')),
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create table public.game_lineup (
  id uuid primary key default gen_random_uuid(),
  game_id uuid references public.games(id) on delete cascade,
  player_id uuid references public.players(id) on delete cascade,
  batting_order int,
  position text,   -- 'P','C','1B', etc.
  unique (game_id, player_id)
);

create table public.team_messages (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  sender_id uuid references public.profiles(id),
  body text not null,
  created_at timestamptz default now()
);
```

### 3.3 Roster-per-season question (needs your decision)
Two valid models:
1. **Roster resets per season** — `players.season_id` required; a kid who plays 3 seasons = 3 player rows, manually re-added each season (more admin work, but clean season stats).
2. **Roster persists on the team**, and a join table `season_rosters (season_id, player_id, active)` marks who's active that season (less re-entry, slightly more complex queries).

*Recommendation:* Option 2 — family accounts, RSVPs, and chat history feel broken if a kid "disappears" every season. I'd keep `players` team-level and add `season_rosters`. I modeled the DDL above with `season_id` nullable on `players` to keep this flexible — happy to finalize either way.

### 3.4 The "max 3 admins" rule
Enforce with a Postgres trigger, not just app logic (defense in depth):

```sql
create or replace function enforce_max_admins()
returns trigger as $$
begin
  if new.role = 'admin' and new.status = 'approved' then
    if (select count(*) from team_members
        where team_id = new.team_id and role = 'admin' and status = 'approved') >= 3 then
      raise exception 'Team already has 3 admins';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger trg_max_admins
before insert or update on team_members
for each row execute function enforce_max_admins();
```

---

## 4. Permissions & RLS Strategy

Every table is protected by Row Level Security keyed off `team_members.status = 'approved'` and `role`. General pattern:

```sql
-- Helper function, reusable across policies
create or replace function is_team_admin(p_team_id uuid)
returns boolean as $$
  select exists (
    select 1 from team_members
    where team_id = p_team_id and user_id = auth.uid()
      and role = 'admin' and status = 'approved'
  );
$$ language sql security definer stable;

create or replace function is_approved_member(p_team_id uuid)
returns boolean as $$
  select exists (
    select 1 from team_members
    where team_id = p_team_id and user_id = auth.uid() and status = 'approved'
  );
$$ language sql security definer stable;
```

| Resource | Fan (approved) | Family (approved) | Admin |
|---|---|---|---|
| Team profile, record | Read | Read | Read/Write |
| Roster (players) | Read (names/numbers only) | Read | Read/Write |
| Calendar/events | Read | Read | Read/Write |
| RSVP (their kid only) | ✗ | Read/Write own kid's | Read/Write all |
| Snack sign-up | Read | Read/Write own | Read/Write all |
| Chat | ✗ (fans don't get chat — confirm this) | Read/Write | Read/Write |
| Live scoring input | ✗ | ✗ | Write |
| Live/final scores | Read | Read | Read/Write |
| Join requests | Create (as fan) | Create (as family + select kid) | Approve/Reject/Remove |
| Roster management | ✗ | ✗ | Full |

**Open question:** you didn't explicitly say whether fans get chat access — I've assumed **no** (chat is a family-only space) since that matches how GameChanger-style apps typically segment "team family" vs "public followers." Confirm or correct.

---

## 5. Core Workflows

### 5.1 Join & approval flow
1. User searches/finds team (public team code or search by name+location).
2. Chooses role intent: **Family** or **Fan**.
3. If Family → must select which roster player(s) they're linked to (multi-select if they have 2 kids on the team) → creates `team_members(status='pending')` + `family_links` rows (also pending until approved — don't materialize until admin approves, to avoid a rejected request leaving stray links).
4. Admin sees pending queue, approves/rejects. On approve: `status='approved'`, `family_links` activated, welcome notification sent.
5. Fan flow is same minus the player-selection step.

### 5.2 Event + RSVP + snack flow
1. Admin creates event (game or practice) with date/time/location/opponent.
2. System auto-creates an `event_rsvps` row per active roster player (status `no_response`) — so admins immediately see who hasn't answered.
3. Family member marks their kid yes/no/maybe → triggers realtime update to admin's roster-for-this-game view.
4. Snack assignment: admin (or self-serve family sign-up) assigns/claims a slot tied to the event. Notification reminder sent 24h before (Edge Function cron).

### 5.3 Live scoring flow
1. Admin opens "Score Game" on a scheduled event → creates `games` row, sets lineup from roster (`game_lineup`).
2. Each scoring action (run scored, inning change) inserts into `game_score_events` (append-only) and updates the cached `our_score`/`opponent_score`/`current_inning` on `games` in the same transaction (Postgres function, not two separate client writes — avoids race conditions with a single admin scoring quickly, or a co-admin scoring from another device).
3. All connected clients (family + fans) subscribe via Supabase Realtime to `games:id=eq.<id>` and `game_score_events` inserts → live-updating scoreboard, no polling.
4. Game end → admin marks `status='final'` → triggers season record recalculation (materialized view or a `team_season_records` summary table, refreshed via trigger or Edge Function).

### 5.4 Offline behavior (PWA)
- **Reads**: On load, cache team/roster/calendar/last-known scores into IndexedDB (Dexie). If offline, app serves from cache with a subtle "offline — showing last synced data" banner.
- **Writes while offline**: Only for family actions that make sense offline-first — RSVP, snack claim, chat message. Queue in an `outbox` table in IndexedDB; sync on reconnect via background sync (Serwist) or on next app open.
- **Live scoring is NOT offline-friendal by nature** — it's a single source of truth for everyone watching. Admin scoring device should require connectivity; if it drops mid-game, queue writes locally and flush on reconnect, but warn the admin scoring is paused until back online (don't silently desync).

---

## 6. i18n Strategy

- `next-intl`, message catalogs in `/messages/es.json` and `/messages/en.json`.
- Default locale `es`; toggle stored in `profiles.preferred_locale`, also mirrored to a cookie for pre-auth pages.
- All user-generated content (chat, event titles) stays as-typed — we don't auto-translate content, only UI chrome and system-generated text (notifications, labels, position names like "Pitcher/Lanzador").
- Position names, RSVP statuses, roles — store as enums in DB (language-agnostic), map to labels via i18n keys in the app layer. Never store translated strings in the DB.

---

## 7. Notifications

MVP channel: **Web Push** (works with PWA, no app store needed).
- Event created/updated → notify family + fans who opted in.
- RSVP reminder (cron, 48h/24h before event) → family only.
- Join request submitted → admins.
- Join request decided → the requester.
- Game went live / final score → fans + family who follow.

Edge Function `send-notification` triggered by Postgres webhooks (Supabase's `pg_net`/Database Webhooks) on relevant table inserts, rather than client-side fire-and-forget — more reliable and keeps notification logic server-side/testable.

---

## 8. MVP Phased Roadmap

| Phase | Scope | Rough effort |
|---|---|---|
| **0. Foundation** | Monorepo setup, Supabase project, auth (phone+email), i18n scaffold, design system base, RLS helper functions | 1–1.5 wk |
| **1. Teams & Roster** | Create team, seasons, roster CRUD, join request + approval flow, 3-admin cap, family_links | 1.5–2 wk |
| **2. Calendar & RSVP** | Event CRUD, calendar view, per-kid RSVP, snack sign-up | 1.5 wk |
| **3. Live Scoring** | Games table, score entry UI, realtime broadcast, season record calc | 2 wk |
| **4. Chat & Notifications** | Team chat, web push, reminder cron jobs | 1.5 wk |
| **5. PWA/Offline polish** | Service worker, IndexedDB cache, outbox sync, installability, ES/EN toggle everywhere, QA pass | 1.5–2 wk |

~9–11 weeks for a single strong full-stack dev; compressible with parallel work once Phase 0/1 land.

---

## 9. Open Decisions Before We Start Building

1. **Roster persistence model** — reset per season vs. persist team-level with season activation (I recommend the latter — §3.3).
2. **Do fans get chat access?** (assumed no above)
3. **Team discovery** — is there a public directory/search, or is joining always via invite code/link? (Affects onboarding UX and whether team pages need to be public/SEO-indexable — could actually help organic growth in the Hispanic community market.)
4. **Multi-sport data model now vs later** — since baseball-only is MVP, do we want `games`/scoring tables generic enough to swap in soccer/basketball later, or fully baseball-shaped (innings) for speed now? I've modeled it baseball-shaped above; a sport-agnostic scoring engine is more work but avoids a schema migration later.
5. **Notification channels beyond push** — SMS/WhatsApp matters a lot for this audience; is that Phase 2 or should we budget for Twilio/WhatsApp Business API sooner?
6. **Payments** — any plan for team fees/dues collection later? Doesn't need building now, but worth knowing if `teams`/`team_members` needs a Stripe customer hook eventually.

---

## 10. Suggested Immediate Next Steps
1. Confirm/adjust the open decisions in §9.
2. I scaffold the Supabase schema + RLS policies as actual migration files.
3. I scaffold the Next.js monorepo (App Router, Serwist PWA config, next-intl, Supabase client setup, auth flow).
4. Build Phase 1 (Teams & Roster) end-to-end as the first vertical slice.
