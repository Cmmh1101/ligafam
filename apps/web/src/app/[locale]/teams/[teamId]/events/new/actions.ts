"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { toUtcIso } from "@/lib/datetime";
import type { EventType } from "@/lib/supabase/database.types";
import { approvedTeamMemberIds } from "@/lib/push/recipients";
import { claimRecipients } from "@/lib/push/claim";
import { sendPushToUsers } from "@/lib/push/send";

const EVENT_TYPES: EventType[] = ["game", "practice", "other"];

export async function createEventAction(locale: string, teamId: string, formData: FormData) {
  const rawType = String(formData.get("type") ?? "game");
  const type: EventType = EVENT_TYPES.includes(rawType as EventType) ? (rawType as EventType) : "game";
  const title = String(formData.get("title") ?? "").trim();
  const opponentName = String(formData.get("opponentName") ?? "").trim();
  const location = String(formData.get("location") ?? "").trim();
  const startsAt = String(formData.get("startsAt") ?? "");
  const endsAt = String(formData.get("endsAt") ?? "");

  if (!startsAt) {
    return;
  }

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return;
  }

  const { data: season } = await supabase
    .from("seasons")
    .select("id")
    .eq("team_id", teamId)
    .eq("is_active", true)
    .maybeSingle();

  // Relies on the existing "events: admins write" RLS policy — no RPC
  // needed, a non-admin's insert is simply rejected by Postgres.
  const { data: event } = await supabase
    .from("events")
    .insert({
      team_id: teamId,
      season_id: season?.id ?? null,
      type,
      title: title || null,
      opponent_name: opponentName || null,
      location: location || null,
      starts_at: toUtcIso(startsAt),
      ends_at: endsAt ? toUtcIso(endsAt) : null,
      created_by: user.id
    })
    .select("id")
    .single();

  if (!event) {
    return;
  }

  if (type === "game") {
    // Awaited (not fire-and-forget) before redirect() -- redirect() throws
    // to short-circuit this action, and an un-awaited call issued right
    // before that has no guarantee of finishing on Netlify's Functions
    // runtime. A send failure must not block the redirect, hence the catch.
    try {
      const recipientIds = await approvedTeamMemberIds(teamId, { excludeUserId: user.id });
      const claimed = await claimRecipients(event.id, "game_scheduled", recipientIds);
      await sendPushToUsers(claimed, "game_scheduled", {
        opponent: opponentName,
        url: `/${locale}/teams/${teamId}/events/${event.id}`
      });
    } catch (err) {
      console.error("[createEventAction] notifyGameScheduled failed", err);
    }
  }

  redirect(`/${locale}/teams/${teamId}/events/${event.id}?toast=toast.eventCreated`);
}
