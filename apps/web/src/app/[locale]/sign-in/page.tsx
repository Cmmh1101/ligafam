import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { SignInForm } from "@/components/auth/sign-in-form";

export default async function SignInPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  const { error, next } = await searchParams;

  if (user) {
    redirect(next ?? "/");
  }

  const t = await getTranslations("auth");
  const tCommon = await getTranslations("common");

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold text-slate-900">{tCommon("appName")}</h1>
        <p className="text-sm text-slate-500">{t("tagline")}</p>
      </div>

      {error && <p className="text-sm text-red-600">{t("genericError")}</p>}
      <SignInForm />
    </main>
  );
}
