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
