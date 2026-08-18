import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SubmitButton } from "@/components/submit-button";
import { TeamLogo } from "@/components/teams/team-logo";
import { updateTeamAction } from "./actions";

export default async function EditTeamPage({
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

  const { data: team } = await supabase
    .from("teams")
    .select("id, name, age_group, visibility, logo_url")
    .eq("id", teamId)
    .maybeSingle();

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

  const updateTeam = updateTeamAction.bind(null, locale, teamId);

  return (
    <>
      <a href={`/${locale}/teams/${teamId}`} className="text-sm text-slate-500 underline">
        {t("common.back")}
      </a>
      <h1 className="text-xl font-semibold text-slate-900">{t("team.editTeam")}</h1>

      {error && <p className="text-sm text-red-600">{t(error)}</p>}

      <form action={updateTeam} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">{t("team.logo")}</span>
          <TeamLogo logoUrl={team.logo_url} name={team.name} size={64} />
          <input
            name="logo"
            type="file"
            accept="image/*"
            className="text-sm text-slate-700"
          />
          <p className="text-xs text-slate-500">{t("team.logoHint")}</p>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="name">
            {t("team.teamName")}
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
            defaultValue={team.name}
            className="rounded-lg border border-slate-300 px-4 py-3"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="ageGroup">
            {t("team.ageGroup")}
          </label>
          <input
            id="ageGroup"
            name="ageGroup"
            type="text"
            placeholder={t("team.ageGroupHint")}
            defaultValue={team.age_group ?? ""}
            className="rounded-lg border border-slate-300 px-4 py-3"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="visibility">
            {t("team.fields.visibility")}
          </label>
          <select
            id="visibility"
            name="visibility"
            defaultValue={team.visibility}
            className="rounded-lg border border-slate-300 px-4 py-3"
          >
            <option value="public">{t("team.visibility.public")}</option>
            <option value="private">{t("team.visibility.private")}</option>
          </select>
        </div>

        <SubmitButton
          label={t("common.save")}
          pendingLabel={t("common.saving")}
          className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white"
        />
      </form>
    </>
  );
}
