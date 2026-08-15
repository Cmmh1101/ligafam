"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { subscribeToPushAction, unsubscribeFromPushAction } from "@/app/[locale]/profile/actions";
import { urlBase64ToUint8Array } from "@/lib/push/client-utils";

type Status = "checking" | "unsupported" | "denied" | "subscribed" | "unsubscribed";

export function PushToggle() {
  const t = useTranslations("notifications");
  const [status, setStatus] = useState<Status>("checking");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setStatus(subscription ? "subscribed" : "unsubscribed"))
      .catch(() => setStatus("unsupported"));
  }, []);

  async function enable() {
    setLoading(true);
    setError(null);
    try {
      if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
        // Build-time env var missing from this deployment -- fails loudly
        // instead of urlBase64ToUint8Array(undefined) throwing silently
        // three awaits deep, which previously left the button looking like
        // it did nothing at all.
        setError(t("notConfigured"));
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) as BufferSource
      });
      await subscribeToPushAction(subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } });
      setStatus("subscribed");
    } catch (err) {
      console.error("[PushToggle] subscribe failed", err);
      setError(t("enableFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function disable() {
    setLoading(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await unsubscribeFromPushAction(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setStatus("unsubscribed");
    } catch (err) {
      console.error("[PushToggle] unsubscribe failed", err);
      setError(t("disableFailed"));
    } finally {
      setLoading(false);
    }
  }

  if (status === "checking") return null;

  const toggleable = status === "subscribed" || status === "unsubscribed";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-medium text-slate-700">{t("title")}</h2>
          <p className="text-xs text-slate-500">{t("description")}</p>
        </div>

        {toggleable && (
          <button
            type="button"
            role="switch"
            aria-checked={status === "subscribed"}
            aria-label={status === "subscribed" ? t("disable") : t("enable")}
            disabled={loading}
            onClick={status === "subscribed" ? disable : enable}
            className={`relative h-7 w-12 shrink-0 appearance-none rounded-full border-0 p-0 transition-colors disabled:opacity-50 ${
              status === "subscribed" ? "bg-slate-900" : "bg-slate-300"
            }`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                status === "subscribed" ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        )}
      </div>

      {status === "unsupported" && <p className="text-xs text-slate-500">{t("unsupported")}</p>}
      {status === "denied" && <p className="text-xs text-red-600">{t("permissionDenied")}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
