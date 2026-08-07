import { getTranslations, getLocale } from "next-intl/server";
import { LocaleToggle } from "@/components/locale-toggle";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { createClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const t = await getTranslations();
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">{t("common.appName")}</h1>
        <LocaleToggle />
      </header>

      {user ? (
        <div className="flex flex-col gap-4">
          <p className="text-slate-600">
            {/* Phase 1: replace with "My Teams" list + join-team CTA */}
            Signed in as {user.email ?? user.phone}
          </p>
          <SignOutButton />
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
