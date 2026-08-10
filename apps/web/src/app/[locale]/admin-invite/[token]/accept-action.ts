"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";

export async function acceptAdminInviteAction(locale: string, token: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_admin_invite", { p_token: token });

  if (error || !data) {
    redirect(`/${locale}/admin-invite/${token}?error=${rpcErrorKey(error?.message)}`);
  }

  redirect(`/${locale}/teams/${data.team_id}`);
}
