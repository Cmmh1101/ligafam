import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { addPlayerAction, toggleSelfLinkAction } from "./actions";

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

  const { data: team } = await supabase.from("teams").select("id").eq("id", teamId).maybeSingle();

  if (!team) {
    return <p className="text-slate-600">{t("team.notFoundOrNotMember")}</p>;
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

  const { data: myMembership } = await supabase
    .from("team_members")
    .select("id")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  const { data: myLinks } = myMembership
    ? await supabase.from("family_links").select("player_id").eq("team_member_id", myMembership.id)
    : { data: [] };

  const myLinkedPlayerIds = new Set((myLinks ?? []).map((l) => l.player_id));

  const addPlayer = addPlayerAction.bind(null, locale, teamId);
  const toggleSelfLink = toggleSelfLinkAction.bind(null, locale, teamId);

  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">{t("team.roster")}</h1>

      {!roster || roster.length === 0 ? (
        <p className="text-slate-600">{t("team.noRoster")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {roster.map((player) => {
            const isLinked = myLinkedPlayerIds.has(player.id);
            const toggleForPlayer = toggleSelfLink.bind(null, player.id);
            return (
              <li
                key={player.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-4 py-3"
              >
                <div className="flex flex-col">
                  <span className="text-slate-900">
                    {player.first_name} {player.last_name}
                  </span>
                  {player.jersey_number && (
                    <span className="text-sm text-slate-500">#{player.jersey_number}</span>
                  )}
                </div>
                <form action={toggleForPlayer}>
                  <button
                    type="submit"
                    className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium ${
                      isLinked
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 text-slate-700 hover:bg-slate-50"
                    }`}
                  >
                    {isLinked ? t("team.linkedToMe") : t("team.linkToMe")}
                  </button>
                </form>
              </li>
            );
          })}
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
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
          />
          <input
            name="lastName"
            type="text"
            required
            placeholder={t("team.lastName")}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
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
    </>
  );
}
