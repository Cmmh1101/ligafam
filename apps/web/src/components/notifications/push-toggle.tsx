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
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus("denied");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!) as BufferSource
      });
      await subscribeToPushAction(subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } });
      setStatus("subscribed");
    } catch (err) {
      console.error("[PushToggle] subscribe failed", err);
    } finally {
      setLoading(false);
    }
  }

  async function disable() {
    setLoading(true);
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
    } finally {
      setLoading(false);
    }
  }

  if (status === "checking") return null;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4">
      <h2 className="text-sm font-medium text-slate-700">{t("title")}</h2>
      <p className="text-xs text-slate-500">{t("description")}</p>

      {status === "unsupported" && <p className="text-xs text-slate-500">{t("unsupported")}</p>}
      {status === "denied" && <p className="text-xs text-red-600">{t("permissionDenied")}</p>}

      {status === "subscribed" && (
        <button
          type="button"
          disabled={loading}
          onClick={disable}
          className="self-start rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
        >
          {t("disable")}
        </button>
      )}

      {status === "unsubscribed" && (
        <button
          type="button"
          disabled={loading}
          onClick={enable}
          className="self-start rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {t("enable")}
        </button>
      )}
    </div>
  );
}
