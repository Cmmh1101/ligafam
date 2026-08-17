"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { toUtcIso } from "@/lib/datetime";
import type { EventType } from "@/lib/supabase/database.types";
import { approvedTeamMemberIds } from "@/lib/push/recipients";
import { claimRecipients } from "@/lib/push/claim";
import { sendPushToUsers } from "@/lib/push/send";

const EVENT_TYPES: EventType[] = ["game", "practice", "other"];

export async function updateEventAction(locale: string, teamId: string, eventId: string, formData: FormData) {
  const rawType = String(formData.get("type") ?? "game");
  const type: EventType = EVENT_TYPES.includes(rawType as EventType) ? (rawType as EventType) : "game";
  const title = String(formData.get("title") ?? "").trim();
  const opponentName = String(formData.get("opponentName") ?? "").trim();
  const location = String(formData.get("location") ?? "").trim();
  const startsAt = String(formData.get("startsAt") ?? "");
  const endsAt = String(formData.get("endsAt") ?? "");
  const rawVisibility = String(formData.get("visibility") ?? "public");
  const visibility = rawVisibility === "private" ? "private" : "public";

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
      ends_at: endsAt ? toUtcIso(endsAt) : null,
      visibility
    })
    .eq("id", eventId)
    .eq("team_id", teamId);

  redirect(`/${locale}/teams/${teamId}/events/${eventId}?toast=toast.eventUpdated`);
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

  redirect(`/${locale}/teams/${teamId}/events?toast=toast.eventDeleted`);
}

// Called client-side (not awaited) right after start_game succeeds, from
// game-score-panel.tsx. Re-reads events/games through the request-scoped
// client -- RLS's "members read" policy on both doubles as the
// membership check (a non-member's select returns nothing), and
// requiring games.status==='live' scopes this to real, already-started
// games. claimRecipients is what makes this safe if two admins both
// call start_game for the same game at once (start_game itself is
// idempotent, but both callers would otherwise double-notify).
export async function notifyGameStartedAction(teamId: string, eventId: string, locale: string) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: event } = await supabase
    .from("events")
    .select("id, opponent_name, visibility")
    .eq("id", eventId)
    .eq("team_id", teamId)
    .maybeSingle();
  if (!event) return;

  const { data: game } = await supabase
    .from("games")
    .select("status")
    .eq("event_id", eventId)
    .maybeSingle();
  if (!game || game.status !== "live") return;

  try {
    const recipientIds = await approvedTeamMemberIds(teamId, {
      excludeUserId: user.id,
      ...(event.visibility === "private" ? { roles: ["admin", "family"] } : {})
    });
    const claimed = await claimRecipients(eventId, "game_live", recipientIds);
    await sendPushToUsers(claimed, "game_live", {
      opponent: event.opponent_name ?? undefined,
      url: `/${locale}/teams/${teamId}/events/${eventId}`
    });
  } catch (err) {
    console.error("[notifyGameStartedAction] failed", err);
  }
}

// Twin of notifyGameStartedAction above -- same membership/RLS reliance,
// same claim-before-send safety against a double-fire. Additionally reads
// the team's own name and final scores, neither of which the game-started
// trigger needs.
export async function notifyGameFinalizedAction(teamId: string, eventId: string, locale: string) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: event } = await supabase
    .from("events")
    .select("id, opponent_name, visibility")
    .eq("id", eventId)
    .eq("team_id", teamId)
    .maybeSingle();
  if (!event) return;

  const { data: game } = await supabase
    .from("games")
    .select("status, our_score, opponent_score")
    .eq("event_id", eventId)
    .maybeSingle();
  if (!game || game.status !== "final") return;

  const { data: team } = await supabase.from("teams").select("name").eq("id", teamId).maybeSingle();
  if (!team) return;

  try {
    const recipientIds = await approvedTeamMemberIds(teamId, {
      excludeUserId: user.id,
      ...(event.visibility === "private" ? { roles: ["admin", "family"] } : {})
    });
    const claimed = await claimRecipients(eventId, "game_final", recipientIds);
    await sendPushToUsers(claimed, "game_final", {
      teamName: team.name,
      opponent: event.opponent_name ?? (locale === "en" ? "Opponent" : "Rival"),
      ourScore: String(game.our_score),
      opponentScore: String(game.opponent_score),
      url: `/${locale}/teams/${teamId}/events/${eventId}`
    });
  } catch (err) {
    console.error("[notifyGameFinalizedAction] failed", err);
  }
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
