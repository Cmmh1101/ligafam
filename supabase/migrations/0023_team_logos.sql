-- ============================================================================
-- Team logos: Supabase Storage bucket + update_team RPC
-- ============================================================================

-- Public-read bucket. One object per team at a fixed path `{teamId}/logo`
-- (no extension -- contentType is set explicitly on upload, and `upsert:
-- true` means a re-upload overwrites in place instead of accumulating
-- orphaned files).
insert into storage.buckets (id, name, public)
values ('team-logos', 'team-logos', true)
on conflict (id) do nothing;

create policy "team logos are publicly readable"
  on storage.objects for select
  using (bucket_id = 'team-logos');

create policy "team admins can upload their team logo"
  on storage.objects for insert
  with check (
    bucket_id = 'team-logos'
    and public.is_team_admin(((storage.foldername(name))[1])::uuid)
  );

create policy "team admins can replace their team logo"
  on storage.objects for update
  using (
    bucket_id = 'team-logos'
    and public.is_team_admin(((storage.foldername(name))[1])::uuid)
  );

create policy "team admins can remove their team logo"
  on storage.objects for delete
  using (
    bucket_id = 'team-logos'
    and public.is_team_admin(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------------
-- update_team: admin-only, mirrors create_team's shape. The Server Action
-- passes through the existing logo_url unchanged when no new file was
-- uploaded, so this never needs an "unchanged" sentinel.
-- ---------------------------------------------------------------------------
create or replace function public.update_team(
  p_team_id uuid,
  p_name text,
  p_age_group text,
  p_visibility text,
  p_logo_url text
) returns public.teams
language plpgsql security definer set search_path = public as $$
declare
  v_team public.teams;
begin
  if not public.is_team_admin(p_team_id) then
    raise exception 'NOT_AUTHORIZED';
  end if;

  update public.teams
  set name = p_name,
      age_group = p_age_group,
      visibility = p_visibility,
      logo_url = p_logo_url
  where id = p_team_id
  returning * into v_team;

  return v_team;
end;
$$;

revoke execute on function public.update_team(uuid, text, text, text, text) from public;
grant execute on function public.update_team(uuid, text, text, text, text) to authenticated;
