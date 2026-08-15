import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SubmitButton } from "@/components/submit-button";
import { createTeamAction } from "./actions";

export default async function NewTeamPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
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
  const boundAction = createTeamAction.bind(null, locale);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <a href={`/${locale}`} className="text-sm text-slate-500 underline">
        {t("common.back")}
      </a>
      <h1 className="text-xl font-semibold text-slate-900">{t("team.createTeamTitle")}</h1>

      {error && <p className="text-sm text-red-600">{t(error)}</p>}

      <form action={boundAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="name">
            {t("team.teamName")}
          </label>
          <input
            id="name"
            name="name"
            type="text"
            required
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
            defaultValue="public"
            className="rounded-lg border border-slate-300 px-4 py-3"
          >
            <option value="public">{t("team.visibility.public")}</option>
            <option value="private">{t("team.visibility.private")}</option>
          </select>
        </div>

        <SubmitButton
          label={t("common.createTeam")}
          pendingLabel={t("common.saving")}
          className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white"
        />
      </form>
    </main>
  );
}
