"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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

  let familyLinkId: string | null = null;
  if (membership.role === "family") {
    const { data: link } = await supabase
      .from("family_links")
      .select("id")
      .eq("team_member_id", membership.id)
      .limit(1)
      .maybeSingle();
    familyLinkId = link?.id ?? null;
  }

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
