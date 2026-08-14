"use client";

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { useToastAction } from "@/components/toast/use-toast-action";

export function InviteAdminForm({ action }: { action: (formData: FormData) => void | Promise<void> }) {
  const t = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);
  const { pending, run } = useToastAction(action, t("toast.adminInviteSent"));

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    run(formData);
    formRef.current?.reset();
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-2">
      <input
        name="email"
        type="email"
        required
        placeholder={t("team.inviteAdminEmailLabel")}
        className="rounded-lg border border-slate-300 px-4 py-3"
      />
      <button type="submit" disabled={pending} className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white">
        {pending ? t("common.saving") : t("team.sendInvite")}
      </button>
    </form>
  );
}
