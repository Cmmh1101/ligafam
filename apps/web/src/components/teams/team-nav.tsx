"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

export function TeamNav({
  teamId,
  locale,
  isApprovedAdmin
}: {
  teamId: string;
  locale: string;
  isApprovedAdmin: boolean;
}) {
  const pathname = usePathname();
  const t = useTranslations();

  const base = `/${locale}/teams/${teamId}`;
  const links = [
    { href: base, label: t("team.home") },
    { href: `${base}/events`, label: t("events.title") },
    ...(isApprovedAdmin ? [{ href: `${base}/roster`, label: t("team.roster") }] : [])
  ];

  return (
    <nav className="flex border-b border-slate-200">
      {links.map((link) => {
        const isActive = link.href === base ? pathname === base : pathname.startsWith(link.href);
        return (
          <a
            key={link.href}
            href={link.href}
            className={`flex-1 border-b-2 py-3 text-center text-sm font-medium ${
              isActive
                ? "border-slate-900 text-slate-900"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {link.label}
          </a>
        );
      })}
    </nav>
  );
}
