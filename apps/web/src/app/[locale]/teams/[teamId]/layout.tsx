import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { TeamNav } from "@/components/teams/team-nav";
import { ProfileMenu } from "@/components/auth/profile-menu";
import { TeamLogo } from "@/components/teams/team-logo";

export default async function TeamLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: Promise<{ teamId: string }>;
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .maybeSingle();
  const profileFullName = profile?.full_name ?? "";

  const { data: team } = await supabase
    .from("teams")
    .select("id, name, logo_url")
    .eq("id", teamId)
    .maybeSingle();

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

  const isApprovedMember = membership?.status === "approved";
  const isApprovedAdmin = isApprovedMember && membership?.role === "admin";

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col">
      <header className="flex items-center justify-between px-6 py-4">
        <a href={`/${locale}`} className="text-sm text-slate-500 underline">
          {t("common.myTeams")}
        </a>
        <div className="flex items-center gap-3">
          <TeamLogo logoUrl={team.logo_url} name={team.name} size={28} />
          <span className="text-sm font-medium text-slate-900">{team.name}</span>
          <ProfileMenu locale={locale} fullName={profileFullName} email={user.email ?? ""} />
        </div>
      </header>

      {isApprovedMember && <TeamNav teamId={teamId} locale={locale} isApprovedAdmin={isApprovedAdmin} />}

      <div className="flex flex-1 flex-col gap-6 p-6">{children}</div>
    </div>
  );
}
