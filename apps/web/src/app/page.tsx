import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";

// Bare "/" has no page of its own — this exists so a stray hit here (e.g. an
// auth redirect that fell back to the Site URL instead of /auth/callback,
// see architecture-plan.md) degrades to the localized home page instead of
// 404ing. It does NOT complete a pending auth exchange by itself — that only
// happens at /auth/callback.
export default async function RootPage() {
  const locale = await getLocale();
  redirect(`/${locale}`);
}
