import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProfileAction } from "./actions";
import { PushToggle } from "@/components/notifications/push-toggle";
import { ProfileForm } from "@/components/profile/profile-form";

export default async function ProfilePage({
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name, phone")
    .eq("id", user.id)
    .maybeSingle();

  const boundAction = updateProfileAction.bind(null, locale);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <a href={`/${locale}`} className="text-sm text-slate-500 underline">
        {t("common.back")}
      </a>
      <h1 className="text-xl font-semibold text-slate-900">{t("profile.title")}</h1>

      {error && <p className="text-sm text-red-600">{t(error)}</p>}

      <ProfileForm
        action={boundAction}
        defaultFullName={profile?.full_name ?? ""}
        defaultPhone={profile?.phone ?? ""}
      />

      <PushToggle />
    </main>
  );
}
