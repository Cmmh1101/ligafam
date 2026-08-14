"use client";

import { useTranslations } from "next-intl";
import { useToastAction } from "@/components/toast/use-toast-action";

export function ActionButton({
  action,
  label,
  pendingLabel,
  successToastKey,
  className
}: {
  action: () => void | Promise<void>;
  label: string;
  pendingLabel?: string;
  successToastKey?: string;
  className?: string;
}) {
  const t = useTranslations();
  const { pending, run } = useToastAction(action, successToastKey ? t(successToastKey) : undefined);

  return (
    <button type="button" onClick={() => run()} disabled={pending} className={className}>
      {pending ? (pendingLabel ?? t("common.saving")) : label}
    </button>
  );
}
