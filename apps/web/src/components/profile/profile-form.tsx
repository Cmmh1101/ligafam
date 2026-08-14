"use client";

import { useTranslations } from "next-intl";
import { useToastAction } from "@/components/toast/use-toast-action";

export function ProfileForm({
  action,
  defaultFullName,
  defaultPhone
}: {
  action: (formData: FormData) => void | Promise<void>;
  defaultFullName: string;
  defaultPhone: string;
}) {
  const t = useTranslations();
  const { pending, run } = useToastAction(action, t("toast.profileUpdated"));

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    run(formData);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="full_name">
          {t("auth.fullName")}
        </label>
        <input
          id="full_name"
          name="full_name"
          type="text"
          required
          defaultValue={defaultFullName}
          className="rounded-lg border border-slate-300 px-4 py-3"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="phone">
          {t("profile.phone")}
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          placeholder={t("profile.phoneHint")}
          defaultValue={defaultPhone}
          className="rounded-lg border border-slate-300 px-4 py-3"
        />
      </div>

      <button type="submit" disabled={pending} className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white">
        {pending ? t("common.saving") : t("common.save")}
      </button>
    </form>
  );
}
