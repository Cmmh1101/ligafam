"use client";

import { useEffect, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { createClient } from "@/lib/supabase/client";

const DISMISSED_KEY = "ligafam:notif-nudge-dismissed";

export function NotificationNudge() {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISSED_KEY)) return;

    let cancelled = false;

    async function check() {
      const supabase = createClient();
      const {
        data: { user }
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
      if (Notification.permission === "denied") return;

      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription || cancelled) return;
        setVisible(true);
      } catch {
        // treat as unsupported -- stay hidden
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, "1");
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm shadow-lg">
      <p className="text-slate-700">
        {t("nudgeText")}{" "}
        <a href={`/${locale}/profile`} className="font-medium underline">
          {t("nudgeLink")}
        </a>
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("nudgeDismiss")}
        className="shrink-0 text-slate-400 hover:text-slate-600"
      >
        ×
      </button>
    </div>
  );
}
