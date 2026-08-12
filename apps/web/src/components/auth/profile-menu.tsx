"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";

function getInitials(fullName: string, email: string): string {
  const trimmed = fullName.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase();
  }
  return (email[0] ?? "?").toUpperCase();
}

export function ProfileMenu({ locale, fullName, email }: { locale: string; fullName: string; email: string }) {
  const t = useTranslations();
  const router = useRouter();
  const supabase = createClient();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-sm font-medium text-white"
        aria-label={t("profile.title")}
      >
        {getInitials(fullName, email)}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-10 flex w-48 flex-col gap-1 rounded-lg border border-slate-200 bg-white p-2 shadow-lg">
          <p className="truncate px-2 py-1 text-xs text-slate-500">{email}</p>
          <a
            href={`/${locale}/profile`}
            className="rounded-md px-2 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {t("profile.title")}
          </a>
          <button
            onClick={signOut}
            className="rounded-md px-2 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            {t("auth.signOut")}
          </button>
        </div>
      )}
    </div>
  );
}
