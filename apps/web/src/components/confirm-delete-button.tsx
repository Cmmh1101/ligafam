"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

export function ConfirmDeleteButton({
  action,
  label,
  className
}: {
  action: () => void | Promise<void>;
  label: string;
  className: string;
}) {
  const t = useTranslations("common");
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className={className}>
        {label}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="text-xs text-slate-500">{t("confirmDelete")}</span>
      <form action={action}>
        <button type="submit" className="text-xs font-medium text-red-600 underline">
          {t("delete")}
        </button>
      </form>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="text-xs font-medium text-slate-500 underline"
      >
        {t("cancel")}
      </button>
    </span>
  );
}
