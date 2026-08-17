-- Adds 'game_final' to notification_log.notification_type's check
-- constraint. This is a plain text + check column (0014), not a real
-- enum, so widening it means dropping and recreating the constraint.
alter table public.notification_log
  drop constraint notification_log_notification_type_check;

alter table public.notification_log
  add constraint notification_log_notification_type_check
  check (notification_type in ('game_scheduled', 'game_live', 'game_final', 'rsvp_reminder', 'snack_reminder'));
