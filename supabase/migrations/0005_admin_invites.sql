-- ============================================================================
-- LigaFam — Admin-invites-admin flow
--
-- Lets an existing admin invite someone specific to become a co-admin
-- (max 3 per team, enforced by the trg_max_admins trigger from 0001). The
-- app does NOT send the invite email itself -- the admin gets a shareable
-- link back and distributes it manually (WhatsApp, text, their own email),
-- sidestepping Supabase's rate-limited built-in email sender entirely for
-- this step.
--
-- team_members.user_id is a hard FK to profiles(id)/auth.users(id), so a
-- row can't be pre-created for someone without an account -- this table +
-- these RPCs are the token-based bridge for "invite someone who may not
-- have registered yet".
-- ============================================================================

create table public.admin_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  invited_email text not null,
  token text unique not null default encode(gen_random_bytes(16), 'hex'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles(id)
);

create unique index one_pending_invite_per_email
  on public.admin_invites(team_id, lower(invited_email)) where status = 'pending';

alter table public.admin_invites enable row level security;

-- Reads (listing invites on the team dashboard) are plain RLS; writes go
-- only through the RPCs below -- same convention as game_score_events: no
-- insert/update policy here on purpose, so failures come back as stable
-- `raise exception 'CODE'` strings the app can map to i18n, not raw
-- RLS/constraint-violation text.
create policy "admin_invites: admins read own team" on public.admin_invites
  for select using (public.is_team_admin(team_id));

-- ---------------------------------------------------------------------------
-- create_admin_invite: admin-only. Refreshes an existing pending invite for
-- the same email instead of erroring on re-invite (matches
-- request_to_join_team's re-request handling in 0003).
-- ---------------------------------------------------------------------------
create or replace function public.create_admin_invite(p_team_id uuid, p_email text)
returns public.admin_invites
language plpgsql security definer set search_path = public as $$
declare
  v_admin_count int;
  v_invite public.admin_invites;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;
  if not public.is_team_admin(p_team_id) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  select count(*) into v_admin_count from public.team_members
    where team_id = p_team_id and role = 'admin' and status = 'approved';
  if v_admin_count >= 3 then
    raise exception 'TEAM_ADMIN_LIMIT_REACHED';
  end if;

  insert into public.admin_invites (team_id, invited_email, invited_by)
  values (p_team_id, lower(trim(p_email)), auth.uid())
  on conflict (team_id, lower(invited_email)) where status = 'pending'
  do update set token = default, created_at = now(), invited_by = auth.uid()
  returning * into v_invite;

  return v_invite;
end;
$$;

-- ---------------------------------------------------------------------------
-- revoke_admin_invite: admin-only, only while still pending.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_admin_invite(p_invite_id uuid)
returns public.admin_invites
language plpgsql security definer set search_path = public as $$
declare
  v_row public.admin_invites;
  v_invite public.admin_invites;
begin
  select * into v_row from public.admin_invites where id = p_invite_id;
  if v_row.id is null then
    raise exception 'INVITE_NOT_FOUND';
  end if;
  if not public.is_team_admin(v_row.team_id) then
    raise exception 'NOT_AUTHORIZED';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'INVITE_NOT_PENDING';
  end if;

  update public.admin_invites
    set status = 'revoked'
    where id = p_invite_id
    returning * into v_invite;

  return v_invite;
end;
$$;

-- ---------------------------------------------------------------------------
-- get_admin_invite: callable pre-auth (granted to anon too) -- the whole
-- point is a not-yet-registered invitee needs to see which team and which
-- email to register with before they have a session. Safe: gated entirely
-- by the 128-bit token, exposes only team name / invited email / status.
-- ---------------------------------------------------------------------------
create or replace function public.get_admin_invite(p_token text)
returns table(team_id uuid, team_name text, invited_email text, status text)
language sql security definer stable set search_path = public as $$
  select ai.team_id, t.name, ai.invited_email, ai.status
  from public.admin_invites ai
  join public.teams t on t.id = ai.team_id
  where ai.token = p_token;
$$;

-- ---------------------------------------------------------------------------
-- accept_admin_invite: the email-match check is what makes "existing
-- account -> just join" and "new account -> register then get added" the
-- same code path -- either way, acceptance requires being authenticated as
-- that exact email. pg_advisory_xact_lock closes the TOCTOU race that
-- trg_max_admins alone doesn't (two concurrent accepts could otherwise
-- both see "2 admins" and both commit a 3rd).
-- ---------------------------------------------------------------------------
create or replace function public.accept_admin_invite(p_token text)
returns public.team_members
language plpgsql security definer set search_path = public as $$
declare
  v_invite public.admin_invites;
  v_existing public.team_members;
  v_member public.team_members;
  v_admin_count int;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select * into v_invite from public.admin_invites where token = p_token;
  if v_invite.id is null then
    raise exception 'INVITE_NOT_FOUND';
  end if;
  if v_invite.status <> 'pending' then
    raise exception 'INVITE_NOT_PENDING';
  end if;
  if lower(auth.email()) <> lower(v_invite.invited_email) then
    raise exception 'INVITE_EMAIL_MISMATCH';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_invite.team_id::text));

  select count(*) into v_admin_count from public.team_members
    where team_id = v_invite.team_id and role = 'admin' and status = 'approved';
  if v_admin_count >= 3 then
    raise exception 'TEAM_ADMIN_LIMIT_REACHED';
  end if;

  select * into v_existing from public.team_members
    where team_id = v_invite.team_id and user_id = auth.uid();

  if v_existing.id is not null then
    update public.team_members
      set role = 'admin', status = 'approved', decided_by = auth.uid(), decided_at = now()
      where id = v_existing.id
      returning * into v_member;
  else
    insert into public.team_members (team_id, user_id, role, status, decided_by, decided_at)
    values (v_invite.team_id, auth.uid(), 'admin', 'approved', auth.uid(), now())
    returning * into v_member;
  end if;

  update public.admin_invites
    set status = 'accepted', accepted_at = now(), accepted_by = auth.uid()
    where id = v_invite.id;

  return v_member;
end;
$$;

revoke execute on function public.create_admin_invite(uuid, text) from public;
revoke execute on function public.revoke_admin_invite(uuid) from public;
revoke execute on function public.get_admin_invite(text) from public;
revoke execute on function public.accept_admin_invite(text) from public;

grant execute on function public.create_admin_invite(uuid, text) to authenticated;
grant execute on function public.revoke_admin_invite(uuid) to authenticated;
grant execute on function public.get_admin_invite(text) to authenticated, anon;
grant execute on function public.accept_admin_invite(text) to authenticated;
