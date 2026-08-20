import { getTranslations, getLocale } from "next-intl/server";
import { LocaleToggle } from "@/components/locale-toggle";
import { ProfileMenu } from "@/components/auth/profile-menu";
import { TeamLogo } from "@/components/teams/team-logo";
import { LandingHero } from "@/components/landing-hero";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const t = await getTranslations();
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  let teams: {
    membershipId: string;
    teamId: string;
    name: string;
    ageGroup: string | null;
    logoUrl: string | null;
    role: string;
    status: string;
    record: { wins: number; losses: number; ties: number } | null;
  }[] = [];

  let profileFullName = "";

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();
    profileFullName = profile?.full_name ?? "";

    const { data: memberships } = await supabase
      .from("team_members")
      .select("id, team_id, role, status")
      .eq("user_id", user.id)
      .order("requested_at", { ascending: false });

    const teamIds = (memberships ?? []).map((m) => m.team_id);

    const { data: teamRows } =
      teamIds.length > 0
        ? await supabase.from("teams").select("id, name, age_group, logo_url").in("id", teamIds)
        : { data: [] };

    const teamById = new Map((teamRows ?? []).map((t) => [t.id, t]));

    // Win-loss record shown on each team's card comes from the active
    // season's team_season_records row, kept up to date automatically by
    // the on_game_finalized trigger (see 0001_init_schema.sql) whenever a
    // game's status flips to 'final' -- no recalculation needed here.
    const { data: seasonRows } =
      teamIds.length > 0
        ? await supabase.from("seasons").select("id, team_id").in("team_id", teamIds).eq("is_active", true)
        : { data: [] };
    const seasonIdToTeamId = new Map((seasonRows ?? []).map((s) => [s.id, s.team_id]));
    const seasonIds = (seasonRows ?? []).map((s) => s.id);

    const { data: recordRows } =
      seasonIds.length > 0
        ? await supabase.from("team_season_records").select("season_id, wins, losses, ties").in("season_id", seasonIds)
        : { data: [] };
    const recordByTeamId = new Map(
      (recordRows ?? []).flatMap((r) => {
        const teamId = seasonIdToTeamId.get(r.season_id);
        if (!teamId) return [];
        return [[teamId, { wins: r.wins, losses: r.losses, ties: r.ties }] as const];
      })
    );

    teams = (memberships ?? []).flatMap((m) => {
      const team = teamById.get(m.team_id);
      if (!team) return [];
      return [
        {
          membershipId: m.id,
          teamId: m.team_id,
          name: team.name,
          ageGroup: team.age_group,
          logoUrl: team.logo_url,
          role: m.role,
          status: m.status,
          record: recordByTeamId.get(m.team_id) ?? null
        }
      ];
    });
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">{t("common.appName")}</h1>
        <div className="flex items-center gap-2">
          <LocaleToggle />
          {user && <ProfileMenu locale={locale} fullName={profileFullName} email={user.email ?? ""} />}
        </div>
      </header>

      {user ? (
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-medium text-slate-500">{t("common.myTeams")}</h2>

            {teams.length === 0 ? (
              <p className="text-slate-600">{t("team.noTeamsYet")}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-3">
                {teams.map((team) => (
                  <li key={team.membershipId}>
                    <a
                      href={`/${locale}/teams/${team.teamId}`}
                      className="flex h-full flex-col items-center gap-2 rounded-lg border border-slate-200 p-4 text-center hover:bg-slate-50"
                    >
                      <TeamLogo logoUrl={team.logoUrl} name={team.name} size={48} />
                      <span className="line-clamp-2 font-medium text-slate-900">{team.name}</span>
                      <span className="text-xs text-slate-500">
                        {t(`roles.${team.role}`)}
                        {team.ageGroup ? ` · ${team.ageGroup}` : ""}
                      </span>
                      <div className="flex flex-col items-center gap-1">
                        {team.status !== "approved" && (
                          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                            {t(`team.status${team.status.charAt(0).toUpperCase()}${team.status.slice(1)}`)}
                          </span>
                        )}
                        {team.record && team.record.wins + team.record.losses + team.record.ties > 0 && (
                          <span className="text-xs font-semibold">
                            <span className="text-green-600">{team.record.wins}</span>
                            <span className="text-slate-400">-</span>
                            <span className="text-red-600">{team.record.losses}</span>
                            {team.record.ties > 0 && (
                              <span className="text-slate-500">-{team.record.ties}</span>
                            )}
                          </span>
                        )}
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <a
              href={`/${locale}/teams/new`}
              className="rounded-lg bg-slate-900 px-4 py-3 text-center font-medium text-white"
            >
              {t("common.createTeam")}
            </a>
            <a
              href={`/${locale}/teams/join`}
              className="rounded-lg border border-slate-300 px-4 py-3 text-center font-medium text-slate-700 hover:bg-slate-50"
            >
              {t("team.joinTeam")}
            </a>
            <a
              href={`/${locale}/teams/search`}
              className="rounded-lg border border-slate-300 px-4 py-3 text-center font-medium text-slate-700 hover:bg-slate-50"
            >
              {t("team.searchTeams")}
            </a>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-between gap-8 py-2">
          <div className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
            <div className="flex flex-col items-center gap-3">
              <h2 className="max-w-[280px] text-2xl font-bold leading-tight text-slate-900">
                {t("landing.headline")}
              </h2>
              <p className="max-w-[260px] text-sm leading-relaxed text-slate-500">
                {t("landing.subtitle")}
              </p>
            </div>
            <LandingHero />
          </div>

          <a
            href={`/${locale}/sign-in`}
            className="w-full rounded-lg bg-slate-900 px-4 py-3 text-center font-medium text-white"
          >
            {t("auth.signIn")}
          </a>
        </div>
      )}
    </main>
  );
}
