"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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
