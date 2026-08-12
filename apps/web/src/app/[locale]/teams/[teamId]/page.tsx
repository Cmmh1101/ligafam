import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { approveRequestAction, rejectRequestAction, removeAdminAction } from "./actions";
import { createAdminInviteAction, revokeAdminInviteAction } from "./admin-invite/actions";

export default async function TeamPage({
  params,
  searchParams
}: {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
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
  const { error } = await searchParams;

  // Team existence + membership are already validated by the parent layout
  // (layout.tsx) before this page ever renders -- still re-fetched here
  // since layouts don't pass data down to pages, but the not-found branch
  // is unreachable in practice and kept only as a defensive fallback.
  const { data: team } = await supabase.from("teams").select("*").eq("id", teamId).maybeSingle();

  if (!team) {
    return <p className="text-slate-600">{t("team.notFoundOrNotMember")}</p>;
  }

  const { data: membership } = await supabase
    .from("team_members")
    .select("role, status")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  const isApprovedMember = membership?.status === "approved";
  const isApprovedAdmin = membership?.role === "admin" && membership?.status === "approved";
  const isCreator = team.created_by === user.id;

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

  let adminInvites: {
    id: string;
    invited_email: string;
    status: string;
    token: string;
  }[] = [];

  if (isApprovedAdmin) {
    const { data } = await supabase
      .from("admin_invites")
      .select("id, invited_email, status, token")
      .eq("team_id", teamId)
      .order("created_at", { ascending: false });
    adminInvites = data ?? [];
  }

  let currentAdmins: { id: string; user_id: string; fullName: string }[] = [];

  if (isCreator) {
    const { data: adminRows } = await supabase
      .from("team_members")
      .select("id, user_id")
      .eq("team_id", teamId)
      .eq("role", "admin")
      .eq("status", "approved")
      .order("decided_at", { ascending: true });

    const adminUserIds = (adminRows ?? []).map((r) => r.user_id);
    const { data: adminProfileRows } =
      adminUserIds.length > 0
        ? await supabase.from("profiles").select("id, full_name").in("id", adminUserIds)
        : { data: [] };

    const adminProfileById = new Map((adminProfileRows ?? []).map((p) => [p.id, p]));

    currentAdmins = (adminRows ?? []).flatMap((r) => {
      const profile = adminProfileById.get(r.user_id);
      if (!profile) return [];
      return [{ id: r.id, user_id: r.user_id, fullName: profile.full_name }];
    });
  }

  const host = (await headers()).get("host");
  const origin = host ? `${host.startsWith("localhost") ? "http" : "https"}://${host}` : "";

  const approveAction = approveRequestAction.bind(null, locale, teamId);
  const rejectAction = rejectRequestAction.bind(null, locale, teamId);
  const createInvite = createAdminInviteAction.bind(null, locale, teamId);
  const revokeInvite = revokeAdminInviteAction.bind(null, locale, teamId);
  const removeAdmin = removeAdminAction.bind(null, locale, teamId);

  return (
    <>
      {team.age_group && <p className="text-sm text-slate-500">{team.age_group}</p>}

      {error && <p className="text-sm text-red-600">{t(error)}</p>}

      <div className="rounded-lg border border-slate-200 px-4 py-3">
        <p className="text-xs font-medium text-slate-500">{t("team.inviteCode")}</p>
        <p className="font-mono text-lg text-slate-900">{team.invite_code}</p>
        <p className="text-xs text-slate-500">{t("team.inviteCodeHint")}</p>
      </div>

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

      {isApprovedAdmin && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-slate-500">{t("team.inviteAdmin")}</h2>

          <form action={createInvite} className="flex flex-col gap-2">
            <input
              name="email"
              type="email"
              required
              placeholder={t("team.inviteAdminEmailLabel")}
              className="rounded-lg border border-slate-300 px-4 py-3"
            />
            <button type="submit" className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white">
              {t("team.sendInvite")}
            </button>
          </form>

          {adminInvites.length > 0 && (
            <div className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-slate-500">{t("team.adminInvites")}</h3>
              <ul className="flex flex-col gap-2">
                {adminInvites.map((invite) => {
                  const revokeWithId = revokeInvite.bind(null, invite.id);
                  return (
                    <li
                      key={invite.id}
                      className="flex flex-col gap-2 rounded-lg border border-slate-200 px-4 py-3"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-slate-900">{invite.invited_email}</span>
                        <span className="text-xs text-slate-500">
                          {t(
                            `team.inviteStatus${invite.status.charAt(0).toUpperCase()}${invite.status.slice(1)}`
                          )}
                        </span>
                      </div>
                      {invite.status === "pending" && (
                        <>
                          <p className="break-all rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-600">
                            {origin}/{locale}/admin-invite/{invite.token}
                          </p>
                          <p className="text-xs text-slate-500">{t("team.inviteLinkCreated")}</p>
                          <form action={revokeWithId}>
                            <button
                              type="submit"
                              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
                            >
                              {t("team.revoke")}
                            </button>
                          </form>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {isCreator && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-slate-500">{t("team.currentAdmins")}</h2>

          <ul className="flex flex-col gap-2">
            {currentAdmins.map((admin) => {
              const isSelf = admin.user_id === user.id;
              const removeWithId = removeAdmin.bind(null, admin.id);
              return (
                <li
                  key={admin.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                >
                  <span className="text-slate-900">
                    {admin.fullName}
                    {isSelf ? ` (${t("team.you")})` : ""}
                  </span>
                  {!isSelf && (
                    <form action={removeWithId}>
                      <button
                        type="submit"
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
                      >
                        {t("team.removeAdmin")}
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </>
  );
}
