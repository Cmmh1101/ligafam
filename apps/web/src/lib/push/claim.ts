import { createServiceClient } from "@/lib/supabase/service";

export type NotificationType = "game_scheduled" | "game_live" | "rsvp_reminder" | "snack_reminder";

// Claim-before-send: notification_log's unique(user_id, event_id,
// notification_type) constraint is the dedup lock. Only recipients whose
// row was actually inserted here should receive a push -- this makes
// concurrent duplicate triggers (e.g. two admins starting the same game
// at once, or an overlapping reminder-cron window re-scanning the same
// event) safe without any extra locking.
export async function claimRecipients(
  eventId: string,
  notificationType: NotificationType,
  userIds: string[]
): Promise<string[]> {
  if (userIds.length === 0) return [];

  const supabase = createServiceClient();
  const rows = userIds.map((userId) => ({
    user_id: userId,
    event_id: eventId,
    notification_type: notificationType
  }));

  const { data, error } = await supabase
    .from("notification_log")
    .upsert(rows, { onConflict: "user_id,event_id,notification_type", ignoreDuplicates: true })
    .select("user_id");

  if (error) {
    console.error("[claimRecipients] failed", error);
    return [];
  }

  return (data ?? []).map((row) => row.user_id);
}
