"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function addPlayerAction(locale: string, teamId: string, formData: FormData) {
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const jerseyNumber = String(formData.get("jerseyNumber") ?? "").trim();

  if (!firstName || !lastName) {
    return;
  }

  const supabase = await createClient();
  // Relies on the existing "players: admins write" RLS policy — no RPC
  // needed, a non-admin's insert is simply rejected by Postgres.
  await supabase.from("players").insert({
    team_id: teamId,
    first_name: firstName,
    last_name: lastName,
    jersey_number: jerseyNumber || null
  });

  revalidatePath(`/${locale}/teams/${teamId}/roster`);
}

// Lets an admin link themselves to a player too, so they can RSVP for their
// own kid on top of managing the team -- distinct from the join flow, which
// explicitly blocks admin from self-service family linking
// (ADMIN_NOT_ALLOWED_VIA_JOIN). Relies on the existing "family_links:
// admins manage" RLS policy (is_team_admin check, no role restriction on
// which team_member_id it applies to) -- no migration needed.
export async function toggleSelfLinkAction(locale: string, teamId: string, playerId: string) {
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

  const { data: existing } = await supabase
    .from("family_links")
    .select("id")
    .eq("team_member_id", membership.id)
    .eq("player_id", playerId)
    .maybeSingle();

  if (existing) {
    await supabase.from("family_links").delete().eq("id", existing.id);
  } else {
    await supabase.from("family_links").insert({ team_member_id: membership.id, player_id: playerId });
  }

  revalidatePath(`/${locale}/teams/${teamId}/roster`);
}

// Hard-deletes the player row -- season_rosters/family_links/event_rsvps/
// game_lineup all cascade away with it (players.id has no restrict/
// no-action FKs anywhere in the schema), and any game currently pointing
// at this player as current_batter/current_pitcher gets nulled out.
// That's exactly what's wanted for a genuine duplicate entry, but it also
// means this silently destroys real RSVP/lineup history for a player who
// has any -- there's no undo.
export async function removePlayerAction(locale: string, teamId: string, playerId: string) {
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

  // Relies on the existing "players: admins delete" RLS policy — no RPC
  // needed, a non-admin's delete is simply rejected by Postgres.
  await supabase.from("players").delete().eq("id", playerId).eq("team_id", teamId);

  revalidatePath(`/${locale}/teams/${teamId}/roster`);
}
