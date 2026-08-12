import { getTranslations, getLocale } from "next-intl/server";
import { LocaleToggle } from "@/components/locale-toggle";
import { ProfileMenu } from "@/components/auth/profile-menu";
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
    role: string;
    status: string;
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
        ? await supabase.from("teams").select("id, name, age_group").in("id", teamIds)
        : { data: [] };

    const teamById = new Map((teamRows ?? []).map((t) => [t.id, t]));

    teams = (memberships ?? []).flatMap((m) => {
      const team = teamById.get(m.team_id);
      if (!team) return [];
      return [
        {
          membershipId: m.id,
          teamId: m.team_id,
          name: team.name,
          ageGroup: team.age_group,
          role: m.role,
          status: m.status
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
              <ul className="flex flex-col gap-2">
                {teams.map((team) => (
                  <li key={team.membershipId}>
                    <a
                      href={`/${locale}/teams/${team.teamId}`}
                      className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3 hover:bg-slate-50"
                    >
                      <div className="flex flex-col">
                        <span className="font-medium text-slate-900">{team.name}</span>
                        <span className="text-xs text-slate-500">
                          {t(`roles.${team.role}`)}
                          {team.ageGroup ? ` · ${team.ageGroup}` : ""}
                        </span>
                      </div>
                      {team.status !== "approved" && (
                        <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                          {t(`team.status${team.status.charAt(0).toUpperCase()}${team.status.slice(1)}`)}
                        </span>
                      )}
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
        <a
          href={`/${locale}/sign-in`}
          className="rounded-lg bg-slate-900 px-4 py-3 text-center font-medium text-white"
        >
          {t("auth.signIn")}
        </a>
      )}
    </main>
  );
}
