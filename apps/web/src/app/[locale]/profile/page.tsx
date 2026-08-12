import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProfileAction } from "./actions";

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

      <form action={boundAction} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="full_name">
            {t("auth.fullName")}
          </label>
          <input
            id="full_name"
            name="full_name"
            type="text"
            required
            defaultValue={profile?.full_name ?? ""}
            className="rounded-lg border border-slate-300 px-4 py-3"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="phone">
            {t("profile.phone")}
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            placeholder={t("profile.phoneHint")}
            defaultValue={profile?.phone ?? ""}
            className="rounded-lg border border-slate-300 px-4 py-3"
          />
        </div>

        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white">
          {t("common.save")}
        </button>
      </form>
    </main>
  );
}
