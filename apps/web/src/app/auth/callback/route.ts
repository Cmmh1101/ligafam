import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from "@/i18n/request";

// Exchanges the code from a Google OAuth or email magic-link redirect for a
// session. Both flows point here via redirectTo/emailRedirectTo.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  const cookieLocale = (await cookies()).get("locale")?.value;
  const locale: Locale = SUPPORTED_LOCALES.includes(cookieLocale as Locale)
    ? (cookieLocale as Locale)
    : DEFAULT_LOCALE;

  return NextResponse.redirect(`${origin}/${locale}/sign-in?error=auth`);
}
