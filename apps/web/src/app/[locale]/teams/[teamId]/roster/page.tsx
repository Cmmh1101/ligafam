import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { addPlayerAction } from "./actions";

export default async function RosterPage({ params }: { params: Promise<{ teamId: string }> }) {
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

  const { data: team } = await supabase.from("teams").select("id, name").eq("id", teamId).maybeSingle();

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

  if (!isApprovedAdmin) {
    redirect(`/${locale}/teams/${teamId}`);
  }

  const { data: roster } = await supabase
    .from("players")
    .select("id, first_name, last_name, jersey_number")
    .eq("team_id", teamId)
    .order("last_name", { ascending: true });

  const addPlayer = addPlayerAction.bind(null, locale, teamId);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <a href={`/${locale}/teams/${teamId}`} className="text-sm text-slate-500 underline">
          {team.name}
        </a>
        <h1 className="text-xl font-semibold text-slate-900">{t("team.roster")}</h1>
      </header>

      {!roster || roster.length === 0 ? (
        <p className="text-slate-600">{t("team.noRoster")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {roster.map((player) => (
            <li
              key={player.id}
              className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
            >
              <span className="text-slate-900">
                {player.first_name} {player.last_name}
              </span>
              {player.jersey_number && (
                <span className="text-sm text-slate-500">#{player.jersey_number}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <form action={addPlayer} className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4">
        <p className="text-sm font-medium text-slate-700">{t("team.addPlayer")}</p>
        <div className="flex gap-2">
          <input
            name="firstName"
            type="text"
            required
            placeholder={t("team.firstName")}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
          />
          <input
            name="lastName"
            type="text"
            required
            placeholder={t("team.lastName")}
            className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>
        <input
          name="jerseyNumber"
          type="text"
          placeholder={t("team.jerseyNumber")}
          className="rounded-lg border border-slate-300 px-3 py-2"
        />
        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white">
          {t("team.addPlayer")}
        </button>
      </form>
    </main>
  );
}
