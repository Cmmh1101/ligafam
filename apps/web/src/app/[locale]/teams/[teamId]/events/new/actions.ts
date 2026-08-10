"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { toUtcIso } from "@/lib/datetime";
import type { EventType } from "@/lib/supabase/database.types";

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

  redirect(`/${locale}/teams/${teamId}/events/${event.id}`);
}
