-- is_team_creator: internal-only helper, mirrors the shape of
-- next_lineup_batter/next_opponent_lineup_batter (0009/0010) -- only ever
-- called from within remove_team_admin below (a security definer function
-- calling another function it owns has implicit rights regardless of
-- grants), so revoke-only, no grant to authenticated.
create or replace function public.is_team_creator(p_team_id uuid)
returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.teams where id = p_team_id and created_by = auth.uid()
  );
$$;

revoke execute on function public.is_team_creator(uuid) from public;

-- remove_team_admin: demotes an approved admin to role='family'. Only the
-- team's creator may call this; the creator cannot target themselves.
-- No row lock -- unconditional, idempotent single-row UPDATE by id, same
-- shape as approve_join_request/reject_join_request (0003), not the
-- multi-row-mutation shape that set_lineup/advance_batter lock for.
create or replace function public.remove_team_admin(p_team_member_id uuid)
returns public.team_members
language plpgsql security definer set search_path = public as $$
declare
  v_row public.team_members;
  v_member public.team_members;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select * into v_row from public.team_members where id = p_team_member_id;
  if v_row.id is null then
    raise exception 'ADMIN_NOT_FOUND';
  end if;

  if not public.is_team_creator(v_row.team_id) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  if v_row.role <> 'admin' or v_row.status <> 'approved' then
    raise exception 'ADMIN_NOT_FOUND';
  end if;

  if v_row.user_id = auth.uid() then
    raise exception 'CANNOT_REMOVE_SELF';
  end if;

  update public.team_members
    set role = 'family', decided_by = auth.uid(), decided_at = now()
    where id = p_team_member_id
    returning * into v_member;

  return v_member;
end;
$$;

revoke execute on function public.remove_team_admin(uuid) from public;
grant execute on function public.remove_team_admin(uuid) to authenticated;
