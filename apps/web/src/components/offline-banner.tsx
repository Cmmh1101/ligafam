"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

export function OfflineBanner() {
  const t = useTranslations();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(!navigator.onLine);
    function handleOnline() {
      setOffline(false);
    }
    function handleOffline() {
      setOffline(true);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!offline) {
    return null;
  }

  return (
    <div className="bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-800">
      {t("common.offlineBanner")}
    </div>
  );
}
