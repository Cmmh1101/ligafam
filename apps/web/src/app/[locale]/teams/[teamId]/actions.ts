"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";

export async function approveRequestAction(locale: string, teamId: string, teamMemberId: string) {
  const supabase = await createClient();
  await supabase.rpc("approve_join_request", { p_team_member_id: teamMemberId });
  revalidatePath(`/${locale}/teams/${teamId}`);
}

export async function rejectRequestAction(locale: string, teamId: string, teamMemberId: string) {
  const supabase = await createClient();
  await supabase.rpc("reject_join_request", { p_team_member_id: teamMemberId });
  revalidatePath(`/${locale}/teams/${teamId}`);
}

export async function removeAdminAction(locale: string, teamId: string, teamMemberId: string) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_team_admin", { p_team_member_id: teamMemberId });

  if (error) {
    redirect(`/${locale}/teams/${teamId}?error=${rpcErrorKey(error.message)}`);
  }

  revalidatePath(`/${locale}/teams/${teamId}`);
}
