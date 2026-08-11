import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SearchTeamsForm } from "@/components/teams/search-teams-form";

export default async function SearchTeamsPage() {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/${locale}/sign-in`);
  }

  const t = await getTranslations();

  const { data: memberships } = await supabase
    .from("team_members")
    .select("team_id, status")
    .eq("user_id", user.id);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <h1 className="text-xl font-semibold text-slate-900">{t("team.searchTeams")}</h1>
      <SearchTeamsForm
        locale={locale}
        memberships={(memberships ?? []).map((m) => ({ teamId: m.team_id, status: m.status }))}
      />
    </main>
  );
}
