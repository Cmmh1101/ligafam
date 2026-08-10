import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatEventDateTime } from "@/lib/datetime";

export default async function EventsPage({ params }: { params: Promise<{ teamId: string }> }) {
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

  const { data: team } = await supabase.from("teams").select("id, name").eq("id", teamId).maybeSingle();

  if (!team) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <p className="text-slate-600">{t("team.notFoundOrNotMember")}</p>
        <a href={`/${locale}`} className="text-sm text-slate-500 underline">
          {t("common.back")}
        </a>
      </main>
    );
  }

  const { data: membership } = await supabase
    .from("team_members")
    .select("role, status")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  const isApprovedAdmin = membership?.role === "admin" && membership?.status === "approved";

  const { data: events } = await supabase
    .from("events")
    .select("id, type, title, opponent_name, location, starts_at")
    .eq("team_id", teamId)
    .order("starts_at", { ascending: true });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <a href={`/${locale}/teams/${teamId}`} className="text-sm text-slate-500 underline">
          {team.name}
        </a>
        <h1 className="text-xl font-semibold text-slate-900">{t("events.title")}</h1>
      </header>

      {!events || events.length === 0 ? (
        <p className="text-slate-600">{t("events.noUpcomingEvents")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event) => (
            <li key={event.id}>
              <a
                href={`/${locale}/teams/${teamId}/events/${event.id}`}
                className="flex flex-col gap-1 rounded-lg border border-slate-200 px-4 py-3 hover:bg-slate-50"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-900">
                    {event.title || event.opponent_name || t(`events.type.${event.type}`)}
                  </span>
                  <span className="text-xs text-slate-500">{t(`events.type.${event.type}`)}</span>
                </div>
                <span className="text-sm text-slate-500">{formatEventDateTime(event.starts_at, locale)}</span>
                {event.location && <span className="text-xs text-slate-500">{event.location}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}

      {isApprovedAdmin && (
        <a
          href={`/${locale}/teams/${teamId}/events/new`}
          className="rounded-lg bg-slate-900 px-4 py-3 text-center font-medium text-white"
        >
          {t("events.createEvent")}
        </a>
      )}
    </main>
  );
}
