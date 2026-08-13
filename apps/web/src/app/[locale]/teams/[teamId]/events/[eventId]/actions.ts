"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { toUtcIso } from "@/lib/datetime";
import type { EventType } from "@/lib/supabase/database.types";

const EVENT_TYPES: EventType[] = ["game", "practice", "other"];

export async function updateEventAction(locale: string, teamId: string, eventId: string, formData: FormData) {
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
  if (!user) return;

  // Relies on the existing "events: admins update" RLS policy — no RPC
  // needed, a non-admin's update is simply rejected by Postgres.
  await supabase
    .from("events")
    .update({
      type,
      title: title || null,
      opponent_name: opponentName || null,
      location: location || null,
      starts_at: toUtcIso(startsAt),
      ends_at: endsAt ? toUtcIso(endsAt) : null
    })
    .eq("id", eventId)
    .eq("team_id", teamId);

  redirect(`/${locale}/teams/${teamId}/events/${eventId}`);
}

// Cascades: event_rsvps, snack_assignments, and the games row (which
// itself cascades to game_lineup/game_opponent_lineup) all disappear
// with the event -- there's no undo.
export async function deleteEventAction(locale: string, teamId: string, eventId: string) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: membership } = await supabase
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .eq("role", "admin")
    .eq("status", "approved")
    .maybeSingle();
  if (!membership) return;

  // Relies on the existing "events: admins delete" RLS policy — no RPC
  // needed, a non-admin's delete is simply rejected by Postgres.
  await supabase.from("events").delete().eq("id", eventId).eq("team_id", teamId);

  redirect(`/${locale}/teams/${teamId}/events`);
}

export async function claimSnackAction(
  locale: string,
  teamId: string,
  eventId: string,
  formData: FormData
) {
  const item = String(formData.get("item") ?? "").trim();
  if (!item) return;

  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: membership } = await supabase
    .from("team_members")
    .select("id, role, status")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership || membership.status !== "approved") return;

  // Not role-gated: an admin can also be self-linked to a player (roster
  // page's "Vincularme"), and their snack should show that player's name
  // too, not just fall back to "Administrador". Only a plain admin with no
  // self-link, or a role with no family_links at all, ends up null here.
  const { data: link } = await supabase
    .from("family_links")
    .select("id")
    .eq("team_member_id", membership.id)
    .limit(1)
    .maybeSingle();
  const familyLinkId = link?.id ?? null;

  // Relies on "snacks: family manage own" (approved-only as of 0004) and
  // "snacks: admins manage all" RLS -- a fan's insert is simply rejected.
  await supabase.from("snack_assignments").insert({
    event_id: eventId,
    family_link_id: familyLinkId,
    item,
    confirmed: true
  });

  revalidatePath(`/${locale}/teams/${teamId}/events/${eventId}`);
}

export async function deleteSnackAction(
  locale: string,
  teamId: string,
  eventId: string,
  snackId: string
) {
  const supabase = await createClient();
  // Relies entirely on RLS ("snacks: family manage own" / "snacks: admins
  // manage all", both FOR ALL so they cover DELETE too) -- a snack that
  // isn't the caller's own (and they're not an admin) is simply rejected.
  await supabase.from("snack_assignments").delete().eq("id", snackId);
  revalidatePath(`/${locale}/teams/${teamId}/events/${eventId}`);
}
