import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { approveRequestAction, rejectRequestAction } from "./actions";

export default async function TeamPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/${locale}/sign-in`);
  }

  const t = await getTranslations();

  const { data: team } = await supabase.from("teams").select("*").eq("id", teamId).maybeSingle();

  if (!team) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <p className="text-slate-600">{t("team.notFoundOrNotMember")}</p>
        <a href={`/${locale}`} className="text-sm text-slate-500 underline">
          {t("common.back")}
        </a>
      </main>
    );
  }

  const { data: membership } = await supabase
    .from("team_members")
    .select("role, status")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  const isApprovedMember = membership?.status === "approved";
  const isApprovedAdmin = membership?.role === "admin" && membership?.status === "approved";

  let pendingRequests: {
    id: string;
    role: string;
    fullName: string;
    phone: string | null;
    linkedPlayerNames: string[];
  }[] = [];

  if (isApprovedAdmin) {
    const { data: pendingRows } = await supabase
      .from("team_members")
      .select("id, user_id, role, requested_at")
      .eq("team_id", teamId)
      .eq("status", "pending")
      .order("requested_at", { ascending: true });

    const userIds = (pendingRows ?? []).map((r) => r.user_id);
    const memberIds = (pendingRows ?? []).map((r) => r.id);

    const { data: profileRows } =
      userIds.length > 0
        ? await supabase.from("profiles").select("id, full_name, phone").in("id", userIds)
        : { data: [] };

    // family_links are materialized at request time (before approval) --
    // showing who a pending request claims to be tied to is exactly what
    // lets an admin catch an impersonation attempt before granting access.
    const { data: linkRows } =
      memberIds.length > 0
        ? await supabase
            .from("family_links")
            .select("team_member_id, players(first_name, last_name)")
            .in("team_member_id", memberIds)
        : { data: [] };

    const playerNamesByMember = new Map<string, string[]>();
    for (const row of linkRows ?? []) {
      const player = row.players as unknown as { first_name: string; last_name: string } | null;
      if (!player) continue;
      const names = playerNamesByMember.get(row.team_member_id) ?? [];
      names.push(`${player.first_name} ${player.last_name}`);
      playerNamesByMember.set(row.team_member_id, names);
    }

    const profileById = new Map((profileRows ?? []).map((p) => [p.id, p]));

    pendingRequests = (pendingRows ?? []).flatMap((r) => {
      const profile = profileById.get(r.user_id);
      if (!profile) return [];
      return [
        {
          id: r.id,
          role: r.role,
          fullName: profile.full_name,
          phone: profile.phone,
          linkedPlayerNames: playerNamesByMember.get(r.id) ?? []
        }
      ];
    });
  }

  const approveAction = approveRequestAction.bind(null, locale, teamId);
  const rejectAction = rejectRequestAction.bind(null, locale, teamId);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <a href={`/${locale}`} className="text-sm text-slate-500 underline">
          {t("common.myTeams")}
        </a>
        <h1 className="text-xl font-semibold text-slate-900">{team.name}</h1>
        {team.age_group && <p className="text-sm text-slate-500">{team.age_group}</p>}
      </header>

      <div className="rounded-lg border border-slate-200 px-4 py-3">
        <p className="text-xs font-medium text-slate-500">{t("team.inviteCode")}</p>
        <p className="font-mono text-lg text-slate-900">{team.invite_code}</p>
        <p className="text-xs text-slate-500">{t("team.inviteCodeHint")}</p>
      </div>

      {isApprovedMember && (
        <div className="flex gap-2">
          <a
            href={`/${locale}/teams/${teamId}/events`}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-3 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {t("events.title")}
          </a>
          {isApprovedAdmin && (
            <a
              href={`/${locale}/teams/${teamId}/roster`}
              className="flex-1 rounded-lg border border-slate-300 px-4 py-3 text-center text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              {t("team.roster")}
            </a>
          )}
        </div>
      )}

      {isApprovedAdmin && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-slate-500">{t("team.pendingRequests")}</h2>

          {pendingRequests.length === 0 ? (
            <p className="text-slate-600">{t("team.noPendingRequests")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {pendingRequests.map((request) => {
                const approveWithId = approveAction.bind(null, request.id);
                const rejectWithId = rejectAction.bind(null, request.id);
                return (
                  <li
                    key={request.id}
                    className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                  >
                    <div className="flex flex-col">
                      <span className="font-medium text-slate-900">{request.fullName}</span>
                      <span className="text-xs text-slate-500">
                        {t(`roles.${request.role}`)}
                        {request.phone ? ` · ${request.phone}` : ""}
                      </span>
                      {request.linkedPlayerNames.length > 0 && (
                        <span className="text-xs font-medium text-slate-600">
                          {t("team.linkedTo")}: {request.linkedPlayerNames.join(", ")}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <form action={approveWithId}>
                        <button
                          type="submit"
                          className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white"
                        >
                          {t("common.approve")}
                        </button>
                      </form>
                      <form action={rejectWithId}>
                        <button
                          type="submit"
                          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
                        >
                          {t("common.reject")}
                        </button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}
