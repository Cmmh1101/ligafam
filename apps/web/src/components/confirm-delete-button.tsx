"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useToastAction } from "@/components/toast/use-toast-action";

export function ConfirmDeleteButton({
  action,
  label,
  successToastKey,
  className
}: {
  action: () => void | Promise<void>;
  label: string;
  successToastKey?: string;
  className: string;
}) {
  const t = useTranslations("common");
  const tRoot = useTranslations();
  const [confirming, setConfirming] = useState(false);
  const { pending, run } = useToastAction(action, successToastKey ? tRoot(successToastKey) : undefined);

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
      <button
        type="button"
        onClick={() => run()}
        disabled={pending}
        className="text-xs font-medium text-red-600 underline"
      >
        {pending ? t("deleting") : t("delete")}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={pending}
        className="text-xs font-medium text-slate-500 underline"
      >
        {t("cancel")}
      </button>
    </span>
  );
}
