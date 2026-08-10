import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { SignInForm } from "@/components/auth/sign-in-form";

export default async function SignInPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) {
    redirect("/");
  }

  const t = await getTranslations("auth");
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold text-slate-900">{t("signIn")}</h1>
      <p className="text-sm text-slate-500">{t("newHereHint")}</p>
      {error && <p className="text-sm text-red-600">{t("genericError")}</p>}
      <SignInForm />
    </main>
  );
}
