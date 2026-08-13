-- push_subscriptions: device registrations. NO client insert/update
-- policy on purpose -- a push `endpoint` is unique per browser+device
-- install, not per user, so a shared family device re-subscribing under a
-- second user needs to reassign ownership of the row, which a plain
-- "user_id = auth.uid()" policy can't express (it gates on the EXISTING
-- row's owner, not the new caller). Only upsert_push_subscription()
-- writes to this table. Users may still read and delete their own rows
-- directly (delete = "turn off notifications on this device").
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  created_at timestamptz not null default now()
);

create index idx_push_subscriptions_user on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

create policy "push_subscriptions: self read" on public.push_subscriptions
  for select using (user_id = auth.uid());

create policy "push_subscriptions: self delete" on public.push_subscriptions
  for delete using (user_id = auth.uid());

create or replace function public.upsert_push_subscription(
  p_endpoint text, p_p256dh text, p_auth_key text
) returns public.push_subscriptions
language plpgsql security definer set search_path = public as $$
declare
  v_row public.push_subscriptions;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth_key)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth_key)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth_key = excluded.auth_key
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.upsert_push_subscription(text, text, text) from public;
grant execute on function public.upsert_push_subscription(text, text, text) to authenticated;

-- notification_log: per-recipient dedup + claim lock for all 4 push
-- trigger types (game_scheduled, game_live, rsvp_reminder,
-- snack_reminder). Written/read only by server-side code using the
-- service-role client -- RLS enabled with ZERO policies gives
-- anon/authenticated a hard default-deny if this table is ever queried
-- by mistake from the client. The unique constraint IS the claim
-- mechanism: callers `insert ... on conflict do nothing returning`
-- before sending a push, and only send for rows actually returned -- this
-- makes concurrent duplicate triggers (e.g. two admins starting the same
-- game at once) safe, and makes an intentionally overlapping reminder
-- cron window safe to over-fire without double-notifying.
create table public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  notification_type text not null check (
    notification_type in ('game_scheduled', 'game_live', 'rsvp_reminder', 'snack_reminder')
  ),
  sent_at timestamptz not null default now(),
  unique (user_id, event_id, notification_type)
);

create index idx_notification_log_event on public.notification_log(event_id);

alter table public.notification_log enable row level security;
-- No policies -- service-role-only table.
