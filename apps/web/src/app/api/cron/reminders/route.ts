import { createServiceClient } from "@/lib/supabase/service";
import { claimRecipients } from "@/lib/push/claim";
import { sendPushToUsers } from "@/lib/push/send";
import { approvedTeamMemberIds } from "@/lib/push/recipients";
import { DEFAULT_LOCALE } from "@/i18n/request";

// Triggered by pg_cron/pg_net every ~15 min (see the follow-up SQL step
// run after deploy). Window is intentionally wide (±1h around the 24h
// mark) and overlaps across consecutive runs on purpose -- a
// razor-thin, exactly-tiled window risks silently losing an event
// forever if a single cron run is ever missed. claimRecipients'
// notification_log unique constraint is what makes the overlap safe:
// repeat scans of the same event are a guaranteed no-op after the first.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createServiceClient();
  const windowStart = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
  const windowEnd = new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString();

  const { data: events } = await supabase
    .from("events")
    .select("id, team_id, type")
    .in("type", ["game", "practice"])
    .gte("starts_at", windowStart)
    .lte("starts_at", windowEnd);

  const candidateEvents = events ?? [];
  const eventIds = candidateEvents.map((e) => e.id);

  const { data: games } = eventIds.length
    ? await supabase.from("games").select("event_id, status").in("event_id", eventIds)
    : { data: [] };
  const gameStatusByEvent = new Map((games ?? []).map((g) => [g.event_id, g.status]));

  // Drop events whose game was postponed/canceled -- nobody needs to
  // RSVP or bring snacks for something that isn't happening.
  const activeEvents = candidateEvents.filter((e) => {
    const status = gameStatusByEvent.get(e.id);
    return !status || (status !== "postponed" && status !== "canceled");
  });

  let rsvpSent = 0;
  let snackSent = 0;

  // --- RSVP reminders: any still-unanswered player, resolved to their
  // responsible family member(s) via family_links -> team_members. ---
  const activeEventIds = activeEvents.map((e) => e.id);
  if (activeEventIds.length > 0) {
    const { data: rsvps } = await supabase
      .from("event_rsvps")
      .select("event_id, player_id")
      .in("event_id", activeEventIds)
      .eq("status", "no_response");

    const playerIds = [...new Set((rsvps ?? []).map((r) => r.player_id))];
    const { data: links } = playerIds.length
      ? await supabase.from("family_links").select("player_id, team_member_id").in("player_id", playerIds)
      : { data: [] };

    const teamMemberIds = [...new Set((links ?? []).map((l) => l.team_member_id))];
    const { data: members } = teamMemberIds.length
      ? await supabase
          .from("team_members")
          .select("id, user_id")
          .in("id", teamMemberIds)
          .eq("status", "approved")
      : { data: [] };
    const userByTeamMember = new Map((members ?? []).map((m) => [m.id, m.user_id]));

    const usersByPlayer = new Map<string, Set<string>>();
    for (const link of links ?? []) {
      const userId = userByTeamMember.get(link.team_member_id);
      if (!userId) continue;
      if (!usersByPlayer.has(link.player_id)) usersByPlayer.set(link.player_id, new Set());
      usersByPlayer.get(link.player_id)!.add(userId);
    }

    const usersByEvent = new Map<string, Set<string>>();
    for (const rsvp of rsvps ?? []) {
      const users = usersByPlayer.get(rsvp.player_id);
      if (!users) continue;
      if (!usersByEvent.has(rsvp.event_id)) usersByEvent.set(rsvp.event_id, new Set());
      for (const u of users) usersByEvent.get(rsvp.event_id)!.add(u);
    }

    for (const [eventId, userSet] of usersByEvent) {
      const event = activeEvents.find((e) => e.id === eventId)!;
      const claimed = await claimRecipients(eventId, "rsvp_reminder", [...userSet]);
      if (claimed.length > 0) {
        await sendPushToUsers(claimed, "rsvp_reminder", {
          url: `/${DEFAULT_LOCALE}/teams/${event.team_id}/events/${eventId}`
        });
        rsvpSent += claimed.length;
      }
    }
  }

  // --- Snack reminders: game events with zero claims so far, sent only
  // to admin+family (fans have no write access to snack_assignments). ---
  const gameEvents = activeEvents.filter((e) => e.type === "game");
  const gameEventIds = gameEvents.map((e) => e.id);
  const { data: snackRows } = gameEventIds.length
    ? await supabase.from("snack_assignments").select("event_id").in("event_id", gameEventIds)
    : { data: [] };
  const eventsWithSnacks = new Set((snackRows ?? []).map((s) => s.event_id));

  for (const event of gameEvents) {
    if (eventsWithSnacks.has(event.id)) continue;
    const recipientIds = await approvedTeamMemberIds(event.team_id, { roles: ["admin", "family"] });
    const claimed = await claimRecipients(event.id, "snack_reminder", recipientIds);
    if (claimed.length > 0) {
      await sendPushToUsers(claimed, "snack_reminder", {
        url: `/${DEFAULT_LOCALE}/teams/${event.team_id}/events/${event.id}`
      });
      snackSent += claimed.length;
    }
  }

  return Response.json({
    eventsScanned: activeEvents.length,
    rsvpRemindersSent: rsvpSent,
    snackRemindersSent: snackSent
  });
}
