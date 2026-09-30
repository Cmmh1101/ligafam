"use client";

import { useTranslations } from "next-intl";
import { useToast } from "@/components/toast/toast-context";

// One tap, no code to read aloud or retype -- navigator.share hands the
// join link straight to WhatsApp/SMS/etc (how this app's actual audience,
// parents on youth sports teams, shares things), which is why this exists
// alongside the raw invite-code fallback already on this page rather than
// replacing it.
export function ShareTeamButton({ teamName, joinUrl }: { teamName: string; joinUrl: string }) {
  const t = useTranslations();
  const { addToast } = useToast();

  async function share() {
    const shareData = {
      title: t("team.shareTitle", { teamName }),
      text: t("team.shareMessage", { teamName }),
      url: joinUrl
    };

    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (err) {
        // AbortError means the person closed the share sheet themselves --
        // not a failure, nothing to fall back to.
        if (err instanceof Error && err.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(joinUrl);
      addToast(t("toast.linkCopied"), "success");
    } catch {
      addToast(t("errors.generic"), "error");
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      className="flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-4 w-4">
        <circle cx="18" cy="5" r="2.5" />
        <circle cx="6" cy="12" r="2.5" />
        <circle cx="18" cy="19" r="2.5" />
        <line x1="8.2" y1="10.8" x2="15.8" y2="6.2" />
        <line x1="8.2" y1="13.2" x2="15.8" y2="17.8" />
      </svg>
      {t("team.shareTeam")}
    </button>
  );
}
