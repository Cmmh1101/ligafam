import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updatePasswordAction } from "./actions";

export default async function ResetPasswordPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  // No session means this wasn't reached via a valid recovery link --
  // send them to sign in normally rather than showing a password form
  // with nothing to attach it to.
  if (!user) {
    redirect(`/${locale}/sign-in`);
  }

  const t = await getTranslations("auth");
  const { error } = await searchParams;

  const updatePassword = updatePasswordAction.bind(null, locale);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold text-slate-900">{t("resetPasswordTitle")}</h1>

      <form action={updatePassword} className="flex flex-col gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="password">
          {t("newPassword")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          className="rounded-lg border border-slate-300 px-4 py-3"
        />
        <p className="text-xs text-slate-500">{t("passwordHint")}</p>

        {error && <p className="text-sm text-red-600">{t(error)}</p>}

        <button type="submit" className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white">
          {t("updatePassword")}
        </button>
      </form>
    </main>
  );
}
