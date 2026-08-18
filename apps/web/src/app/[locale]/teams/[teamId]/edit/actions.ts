"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";

export async function updateTeamAction(locale: string, teamId: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const ageGroup = String(formData.get("ageGroup") ?? "").trim();
  const rawVisibility = String(formData.get("visibility") ?? "public");
  const visibility = rawVisibility === "private" ? "private" : "public";

  if (!name) {
    redirect(`/${locale}/teams/${teamId}/edit?error=errors.generic`);
  }

  const supabase = await createClient();

  let logoUrl: string | null = null;
  const logoFile = formData.get("logo");

  if (logoFile instanceof File && logoFile.size > 0) {
    const path = `${teamId}/logo`;
    const { error: uploadError } = await supabase.storage
      .from("team-logos")
      .upload(path, logoFile, { upsert: true, contentType: logoFile.type });

    if (uploadError) {
      console.error("[updateTeamAction] logo upload failed:", uploadError);
      redirect(`/${locale}/teams/${teamId}/edit?error=errors.generic`);
    }

    logoUrl = supabase.storage.from("team-logos").getPublicUrl(path).data.publicUrl;
  } else {
    const { data: existingTeam } = await supabase
      .from("teams")
      .select("logo_url")
      .eq("id", teamId)
      .maybeSingle();
    logoUrl = existingTeam?.logo_url ?? null;
  }

  const { error } = await supabase.rpc("update_team", {
    p_team_id: teamId,
    p_name: name,
    p_age_group: ageGroup || null,
    p_visibility: visibility,
    p_logo_url: logoUrl
  });

  if (error) {
    console.error("[updateTeamAction] update_team RPC failed:", error);
    redirect(`/${locale}/teams/${teamId}/edit?error=${rpcErrorKey(error.message)}`);
  }

  redirect(`/${locale}/teams/${teamId}?toast=toast.teamUpdated`);
}
