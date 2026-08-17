import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ConfirmDeleteButton } from "@/components/confirm-delete-button";
import { ActionButton } from "@/components/action-button";
import { InviteAdminForm } from "@/components/teams/invite-admin-form";
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

  type BattingStatRow = {
    at_bats: number;
    hits: number;
    doubles: number;
    triples: number;
    home_runs: number;
    walks: number;
    strikeouts: number;
    runs: number;
    rbi: number;
    stolen_bases: number;
    players: { id: string; first_name: string; last_name: string; jersey_number: string | null } | null;
  };
  type PitchingStatRow = {
    outs_recorded: number;
    strikeouts: number;
    walks_issued: number;
    hits_allowed: number;
    runs_allowed: number;
    players: { id: string; first_name: string; last_name: string; jersey_number: string | null } | null;
  };

  let battingStats: BattingStatRow[] = [];
  let pitchingStats: PitchingStatRow[] = [];

  if (isApprovedMember) {
    const { data: activeSeason } = await supabase
      .from("seasons")
      .select("id")
      .eq("team_id", teamId)
      .eq("is_active", true)
      .maybeSingle();

    if (activeSeason) {
      const [{ data: battingRows }, { data: pitchingRows }] = await Promise.all([
        supabase
          .from("player_season_batting_stats")
          .select(
            "at_bats, hits, doubles, triples, home_runs, walks, strikeouts, runs, rbi, stolen_bases, players(id, first_name, last_name, jersey_number)"
          )
          .eq("season_id", activeSeason.id)
          .order("hits", { ascending: false }),
        supabase
          .from("player_season_pitching_stats")
          .select(
            "outs_recorded, strikeouts, walks_issued, hits_allowed, runs_allowed, players(id, first_name, last_name, jersey_number)"
          )
          .eq("season_id", activeSeason.id)
          .order("strikeouts", { ascending: false })
      ]);
      battingStats = (battingRows ?? []) as unknown as BattingStatRow[];
      pitchingStats = (pitchingRows ?? []) as unknown as PitchingStatRow[];
    }
  }

  function statPlayerName(player: { first_name: string; last_name: string; jersey_number: string | null } | null) {
    if (!player) return "?";
    return `${player.first_name} ${player.last_name}${player.jersey_number ? ` #${player.jersey_number}` : ""}`;
  }

  function formatSeasonAvg(hits: number, atBats: number) {
    if (atBats === 0) return "-";
    return (hits / atBats).toFixed(3).replace(/^0/, "");
  }

  function formatSeasonIp(outs: number) {
    return `${Math.floor(outs / 3)}.${outs % 3}`;
  }

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

      {isApprovedMember && (
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-medium text-slate-500">{t("team.stats.title")}</h2>

          {battingStats.length === 0 && pitchingStats.length === 0 ? (
            <p className="text-slate-600">{t("team.stats.noStatsYet")}</p>
          ) : (
            <>
              {battingStats.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-slate-500">{t("game.stats.battingTitle")}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs text-slate-500">
                          <th className="pr-2 font-medium">{t("game.stats.player")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.abAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.hAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">2B</th>
                          <th className="px-1.5 text-center font-medium">3B</th>
                          <th className="px-1.5 text-center font-medium">HR</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.bbAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.kAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.rAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.rbiAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.sbAbbrev")}</th>
                          <th className="pl-1.5 text-center font-medium">{t("game.stats.avgAbbrev")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {battingStats.map((row, i) => (
                          <tr key={row.players?.id ?? i} className="border-t border-slate-100">
                            <td className="py-1.5 pr-2 text-slate-900">{statPlayerName(row.players)}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.at_bats}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.hits}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.doubles}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.triples}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.home_runs}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.walks}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.strikeouts}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.runs}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.rbi}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.stolen_bases}</td>
                            <td className="pl-1.5 text-center text-slate-700">
                              {formatSeasonAvg(row.hits, row.at_bats)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {pitchingStats.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h3 className="text-xs font-medium text-slate-500">{t("game.stats.pitchingTitle")}</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-xs text-slate-500">
                          <th className="pr-2 font-medium">{t("game.stats.player")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.ipAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.kAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.bbAbbrev")}</th>
                          <th className="px-1.5 text-center font-medium">{t("game.stats.hAbbrev")}</th>
                          <th className="pl-1.5 text-center font-medium">{t("game.stats.rAbbrev")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pitchingStats.map((row, i) => (
                          <tr key={row.players?.id ?? i} className="border-t border-slate-100">
                            <td className="py-1.5 pr-2 text-slate-900">{statPlayerName(row.players)}</td>
                            <td className="px-1.5 text-center text-slate-700">
                              {formatSeasonIp(row.outs_recorded)}
                            </td>
                            <td className="px-1.5 text-center text-slate-700">{row.strikeouts}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.walks_issued}</td>
                            <td className="px-1.5 text-center text-slate-700">{row.hits_allowed}</td>
                            <td className="pl-1.5 text-center text-slate-700">{row.runs_allowed}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
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
                      <ActionButton
                        action={approveWithId}
                        label={t("common.approve")}
                        successToastKey="toast.requestApproved"
                        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white"
                      />
                      <ActionButton
                        action={rejectWithId}
                        label={t("common.reject")}
                        successToastKey="toast.requestRejected"
                        className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
                      />
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

          <InviteAdminForm action={createInvite} />

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
                          <ActionButton
                            action={revokeWithId}
                            label={t("team.revoke")}
                            successToastKey="toast.adminInviteRevoked"
                            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
                          />
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
                    <ConfirmDeleteButton
                      action={removeWithId}
                      label={t("team.removeAdmin")}
                      successToastKey="toast.adminRemoved"
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
                    />
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
