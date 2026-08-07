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

  const isApprovedAdmin = membership?.role === "admin" && membership?.status === "approved";

  let pendingRequests: {
    id: string;
    role: string;
    fullName: string;
    phone: string | null;
  }[] = [];

  if (isApprovedAdmin) {
    const { data: pendingRows } = await supabase
      .from("team_members")
      .select("id, user_id, role, requested_at")
      .eq("team_id", teamId)
      .eq("status", "pending")
      .order("requested_at", { ascending: true });

    const userIds = (pendingRows ?? []).map((r) => r.user_id);

    const { data: profileRows } =
      userIds.length > 0
        ? await supabase.from("profiles").select("id, full_name, phone").in("id", userIds)
        : { data: [] };

    const profileById = new Map((profileRows ?? []).map((p) => [p.id, p]));

    pendingRequests = (pendingRows ?? []).flatMap((r) => {
      const profile = profileById.get(r.user_id);
      if (!profile) return [];
      return [{ id: r.id, role: r.role, fullName: profile.full_name, phone: profile.phone }];
    });
  }

  const approveAction = approveRequestAction.bind(null, locale, teamId);
  const rejectAction = rejectRequestAction.bind(null, locale, teamId);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-slate-900">{team.name}</h1>
        {team.age_group && <p className="text-sm text-slate-500">{team.age_group}</p>}
      </header>

      <div className="rounded-lg border border-slate-200 px-4 py-3">
        <p className="text-xs font-medium text-slate-500">{t("team.inviteCode")}</p>
        <p className="font-mono text-lg text-slate-900">{team.invite_code}</p>
        <p className="text-xs text-slate-500">{t("team.inviteCodeHint")}</p>
      </div>

      {isApprovedAdmin && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-500">{t("team.pendingRequests")}</h2>
            <a href={`/${locale}/teams/${teamId}/roster`} className="text-sm text-slate-600 underline">
              {t("team.roster")}
            </a>
          </div>

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
