"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { Locale } from "@/i18n/request";

/**
 * Flips between es/en. Persists to a cookie immediately for fast UI feedback;
 * on sign-in, this should also PATCH profiles.preferred_locale so the
 * preference follows the user across devices.
 */
export function LocaleToggle() {
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function toggle() {
    const next: Locale = locale === "es" ? "en" : "es";
    document.cookie = `locale=${next}; path=/; max-age=31536000`;
    startTransition(() => router.refresh());
  }

  return (
    <button
      onClick={toggle}
      disabled={isPending}
      className="rounded-full border border-slate-300 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      aria-label="Toggle language / Cambiar idioma"
    >
      {locale === "es" ? "EN" : "ES"}
    </button>
  );
}
