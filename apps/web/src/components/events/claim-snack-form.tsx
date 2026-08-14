"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { useToastAction } from "@/components/toast/use-toast-action";

export function ClaimSnackForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const t = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);
  const { pending, run } = useToastAction(action, t("toast.snackAdded"));

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    run(formData);
    formRef.current?.reset();
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex gap-2">
      <input
        name="item"
        type="text"
        required
        placeholder={t("snacks.itemPlaceholder")}
        className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
      >
        {pending ? t("common.saving") : t("snacks.claim")}
      </button>
    </form>
  );
}
