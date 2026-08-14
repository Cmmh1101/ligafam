"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";

export async function createTeamAction(locale: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const ageGroup = String(formData.get("ageGroup") ?? "").trim();

  if (!name) {
    redirect(`/${locale}/teams/new?error=errors.generic`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_team", {
    p_name: name,
    p_age_group: ageGroup || null
  });

  if (error || !data) {
    console.error("[createTeamAction] create_team RPC failed:", error);
    redirect(`/${locale}/teams/new?error=${rpcErrorKey(error?.message)}`);
  }

  redirect(`/${locale}/teams/${data.id}?toast=toast.teamCreated`);
}
