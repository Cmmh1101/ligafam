import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SubmitButton } from "@/components/submit-button";
import { createEventAction } from "./actions";

export default async function NewEventPage({ params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params;
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/${locale}/sign-in`);
  }

  const t = await getTranslations();

  const { data: team } = await supabase.from("teams").select("id").eq("id", teamId).maybeSingle();

  if (!team) {
    return <p className="text-slate-600">{t("team.notFoundOrNotMember")}</p>;
  }

  const { data: membership } = await supabase
    .from("team_members")
    .select("role, status")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  const isApprovedAdmin = membership?.role === "admin" && membership?.status === "approved";

  if (!isApprovedAdmin) {
    redirect(`/${locale}/teams/${teamId}/events`);
  }

  const createEvent = createEventAction.bind(null, locale, teamId);

  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">{t("events.createEvent")}</h1>

      <form action={createEvent} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="type">
            {t("events.fields.type")}
          </label>
          <select
            id="type"
            name="type"
            defaultValue="game"
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="game">{t("events.type.game")}</option>
            <option value="practice">{t("events.type.practice")}</option>
            <option value="other">{t("events.type.other")}</option>
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="title">
            {t("events.fields.title")}
          </label>
          <input id="title" name="title" type="text" className="rounded-lg border border-slate-300 px-3 py-2" />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="opponentName">
            {t("events.fields.opponentName")}
          </label>
          <input
            id="opponentName"
            name="opponentName"
            type="text"
            placeholder={t("events.fields.opponentNameHint")}
            className="rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="location">
            {t("events.fields.location")}
          </label>
          <input
            id="location"
            name="location"
            type="text"
            className="rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="startsAt">
            {t("events.fields.startsAt")}
          </label>
          <input
            id="startsAt"
            name="startsAt"
            type="datetime-local"
            required
            className="rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="endsAt">
            {t("events.fields.endsAt")}
          </label>
          <input
            id="endsAt"
            name="endsAt"
            type="datetime-local"
            placeholder={t("events.fields.endsAtHint")}
            className="rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>

        <SubmitButton
          label={t("events.createEvent")}
          pendingLabel={t("common.saving")}
          className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white"
        />
      </form>
    </>
  );
}
