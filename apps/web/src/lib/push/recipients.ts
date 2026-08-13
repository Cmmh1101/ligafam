import { createServiceClient } from "@/lib/supabase/service";
import type { TeamRole } from "@/lib/supabase/database.types";

// Two-step (not an embedded select) because team_members has two FKs to
// profiles (user_id, decided_by), which PostgREST can't disambiguate for
// a nested select (PGRST201) -- same pattern used in teams/[teamId]/page.tsx.
export async function approvedTeamMemberIds(
  teamId: string,
  options?: { excludeUserId?: string; roles?: TeamRole[] }
): Promise<string[]> {
  const supabase = createServiceClient();
  let query = supabase.from("team_members").select("user_id").eq("team_id", teamId).eq("status", "approved");
  if (options?.roles) query = query.in("role", options.roles);

  const { data } = await query;
  const ids = (data ?? []).map((row) => row.user_id);
  return options?.excludeUserId ? ids.filter((id) => id !== options.excludeUserId) : ids;
}
