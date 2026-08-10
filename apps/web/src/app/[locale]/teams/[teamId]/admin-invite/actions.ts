"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";

export async function createAdminInviteAction(locale: string, teamId: string, formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return;

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_admin_invite", {
    p_team_id: teamId,
    p_email: email
  });

  if (error) {
    redirect(`/${locale}/teams/${teamId}?error=${rpcErrorKey(error.message)}`);
  }

  revalidatePath(`/${locale}/teams/${teamId}`);
}

export async function revokeAdminInviteAction(locale: string, teamId: string, inviteId: string) {
  const supabase = await createClient();
  await supabase.rpc("revoke_admin_invite", { p_invite_id: inviteId });
  revalidatePath(`/${locale}/teams/${teamId}`);
}
