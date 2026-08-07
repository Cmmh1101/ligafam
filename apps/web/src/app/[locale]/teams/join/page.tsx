import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { JoinTeamForm } from "@/components/teams/join-team-form";

export default async function JoinTeamPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/${locale}/sign-in`);
  }

  const t = await getTranslations();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold text-slate-900">{t("team.joinTeam")}</h1>
      <JoinTeamForm />
    </main>
  );
}
