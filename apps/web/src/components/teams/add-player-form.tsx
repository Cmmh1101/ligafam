"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { useToastAction } from "@/components/toast/use-toast-action";

export function AddPlayerForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const t = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);
  const { pending, run } = useToastAction(action, t("toast.playerAdded"));

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    run(formData);
    formRef.current?.reset();
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4"
    >
      <p className="text-sm font-medium text-slate-700">{t("team.addPlayer")}</p>
      <div className="flex gap-2">
        <input
          name="firstName"
          type="text"
          required
          placeholder={t("team.firstName")}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
        />
        <input
          name="lastName"
          type="text"
          required
          placeholder={t("team.lastName")}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
        />
      </div>
      <input
        name="jerseyNumber"
        type="text"
        placeholder={t("team.jerseyNumber")}
        className="rounded-lg border border-slate-300 px-3 py-2"
      />
      <button type="submit" disabled={pending} className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white">
        {pending ? t("common.saving") : t("team.addPlayer")}
      </button>
    </form>
  );
}
