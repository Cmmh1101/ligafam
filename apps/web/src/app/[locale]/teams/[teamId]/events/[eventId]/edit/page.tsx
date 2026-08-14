import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { toLocalInputValue } from "@/lib/datetime";
import { SubmitButton } from "@/components/submit-button";
import { updateEventAction } from "../actions";

export default async function EditEventPage({
  params
}: {
  params: Promise<{ teamId: string; eventId: string }>;
}) {
  const { teamId, eventId } = await params;
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/${locale}/sign-in`);
  }

  const t = await getTranslations();

  const { data: event } = await supabase
    .from("events")
    .select("id, type, title, opponent_name, location, starts_at, ends_at, visibility")
    .eq("id", eventId)
    .eq("team_id", teamId)
    .maybeSingle();

  if (!event) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-slate-600">{t("events.notFound")}</p>
        <a href={`/${locale}/teams/${teamId}/events`} className="text-sm text-slate-500 underline">
          {t("common.back")}
        </a>
      </div>
    );
  }

  const { data: membership } = await supabase
    .from("team_members")
    .select("role, status")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  const isApprovedAdmin = membership?.role === "admin" && membership?.status === "approved";

  if (!isApprovedAdmin) {
    redirect(`/${locale}/teams/${teamId}/events/${eventId}`);
  }

  const updateEvent = updateEventAction.bind(null, locale, teamId, eventId);

  return (
    <>
      <a href={`/${locale}/teams/${teamId}/events/${eventId}`} className="text-sm text-slate-500 underline">
        {t("common.back")}
      </a>
      <h1 className="text-xl font-semibold text-slate-900">{t("common.edit")}</h1>

      <form action={updateEvent} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="type">
            {t("events.fields.type")}
          </label>
          <select
            id="type"
            name="type"
            defaultValue={event.type}
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
          <input
            id="title"
            name="title"
            type="text"
            defaultValue={event.title ?? ""}
            className="rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="opponentName">
            {t("events.fields.opponentName")}
          </label>
          <input
            id="opponentName"
            name="opponentName"
            type="text"
            defaultValue={event.opponent_name ?? ""}
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
            defaultValue={event.location ?? ""}
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
            defaultValue={toLocalInputValue(event.starts_at)}
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
            defaultValue={event.ends_at ? toLocalInputValue(event.ends_at) : ""}
            placeholder={t("events.fields.endsAtHint")}
            className="rounded-lg border border-slate-300 px-3 py-2"
          />
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="visibility">
            {t("events.fields.visibility")}
          </label>
          <select
            id="visibility"
            name="visibility"
            defaultValue={event.visibility}
            className="rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="public">{t("events.visibility.public")}</option>
            <option value="private">{t("events.visibility.private")}</option>
          </select>
        </div>

        <SubmitButton
          label={t("common.save")}
          pendingLabel={t("common.saving")}
          className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white"
        />
      </form>
    </>
  );
}
