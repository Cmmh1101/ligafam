-- ============================================================================
-- LigaFam — Fan auto-approval + event public/private visibility
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Fan auto-approval
--
-- create or replace over the LIVE 4-arg signature introduced by
-- 0006_team_search.sql (p_invite_code, p_role, p_player_ids, p_team_id) --
-- NOT the original 3-arg 0003 signature, which 0006 already dropped.
-- Signature is unchanged here, so a plain CREATE OR REPLACE is safe and
-- preserves existing grants.
--
-- Fans are read-only (no RSVP/snack writes, no chat access per
-- "messages: family+admins read/write") -- there's nothing for an admin
-- to gate, so a fan join is approved immediately. Family keeps the
-- existing pending-approval flow unchanged.
--
-- decided_by is left NULL: no human admin made this decision, and
-- attributing it to any profile id (including the joiner's own) would be
-- misleading to anything that later reads decided_by as "which admin
-- approved this." decided_at IS set to now(), since it genuinely
-- reflects the moment access was granted, independent of who/what
-- granted it.
-- ---------------------------------------------------------------------------
create or replace function public.request_to_join_team(
  p_invite_code text default null,
  p_role public.team_role default null,
  p_player_ids uuid[] default null,
  p_team_id uuid default null
) returns public.team_members
language plpgsql security definer set search_path = public as $$
declare
  v_team_id uuid;
  v_existing public.team_members;
  v_member public.team_members;
  v_invalid_count int;
  v_status public.member_status;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if p_role is null then
    raise exception 'INVALID_INVITE_CODE';
  end if;

  if p_role = 'admin' then
    raise exception 'ADMIN_NOT_ALLOWED_VIA_JOIN';
  end if;

  if p_team_id is not null then
    v_team_id := p_team_id;
  elsif p_invite_code is not null then
    select id into v_team_id from public.teams where invite_code = p_invite_code;
  end if;

  if v_team_id is null then
    raise exception 'INVALID_INVITE_CODE';
  end if;

  v_status := case when p_role = 'fan' then 'approved' else 'pending' end;

  select * into v_existing from public.team_members
    where team_id = v_team_id and user_id = auth.uid();

  if v_existing.id is not null then
    if v_existing.status = 'approved' then
      raise exception 'ALREADY_MEMBER';
    elsif v_existing.status = 'pending' then
      raise exception 'REQUEST_ALREADY_PENDING';
    end if;

    update public.team_members
      set role = p_role, status = v_status, requested_at = now(),
          decided_by = null,
          decided_at = case when v_status = 'approved' then now() else null end
      where id = v_existing.id
      returning * into v_member;

    delete from public.family_links where team_member_id = v_member.id;
  else
    insert into public.team_members (team_id, user_id, role, status, decided_at)
    values (
      v_team_id, auth.uid(), p_role, v_status,
      case when v_status = 'approved' then now() else null end
    )
    returning * into v_member;
  end if;

  if p_role = 'family' then
    if p_player_ids is null or array_length(p_player_ids, 1) is null then
      raise exception 'FAMILY_REQUIRES_PLAYER_SELECTION';
    end if;

    select count(*) into v_invalid_count
      from unnest(p_player_ids) pid
      where not exists (
        select 1 from public.players pl where pl.id = pid and pl.team_id = v_team_id
      );

    if v_invalid_count > 0 then
      raise exception 'INVALID_PLAYER_SELECTION';
    end if;

    insert into public.family_links (team_member_id, player_id)
    select v_member.id, pid from unnest(p_player_ids) pid
    on conflict (team_member_id, player_id) do nothing;
  end if;

  return v_member;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. events.visibility (public/private)
--
-- Plain text + check constraint, not a real pg enum -- same pattern as
-- admin_invites.status (see database.types.ts's AdminInviteStatus
-- comment). Defaults to 'public' for every event regardless of type,
-- matching today's behavior exactly: every existing row backfills to
-- 'public' via the column default, and every new event stays visible to
-- every approved member unless an admin explicitly flips it to private.
-- ---------------------------------------------------------------------------
alter table public.events
  add column visibility text not null default 'public'
    check (visibility in ('public', 'private'));

-- ---------------------------------------------------------------------------
-- "events: members read" -- a private event is visible to admin + family
-- only (mirrors "messages: family+admins read", which already solves the
-- identical fan-exclusion problem via is_approved_family()). A public
-- event (the default, and every pre-existing row) stays visible to every
-- approved member, fans included, identical to today's behavior.
--
-- This also cascades correctly to event_rsvps/snack_assignments/games/
-- game_score_events/game_lineup, which all gate their own RLS via
-- "exists (select 1 from public.events e where e.id = ... and
-- is_approved_member(e.team_id))" -- a plain subquery on events, subject
-- to events' own RLS, so fans are automatically excluded from a private
-- event's RSVPs/snacks/scores too without touching those policies.
-- ---------------------------------------------------------------------------
drop policy "events: members read" on public.events;

create policy "events: members read" on public.events
  for select using (
    case
      when visibility = 'private' then
        public.is_team_admin(team_id) or public.is_approved_family(team_id)
      else
        public.is_approved_member(team_id)
    end
  );
