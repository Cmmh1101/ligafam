import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatEventDateTime } from "@/lib/datetime";
import { getMonthGridDays, dateKey } from "@/lib/calendar";

function monthParam(year: number, month: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}

export default async function EventsPage({
  params,
  searchParams
}: {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { teamId } = await params;
  const { month: monthQuery } = await searchParams;
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

  const { data: events } = await supabase
    .from("events")
    .select("id, type, title, opponent_name, location, starts_at")
    .eq("team_id", teamId)
    .order("starts_at", { ascending: true });

  const eventIds = (events ?? []).map((e) => e.id);
  const { data: gameRows } =
    eventIds.length > 0
      ? await supabase.from("games").select("event_id, status, our_score, opponent_score").in("event_id", eventIds)
      : { data: [] };
  const gameByEvent = new Map(
    (gameRows ?? []).map((g) => [
      g.event_id,
      { status: g.status, ourScore: g.our_score, opponentScore: g.opponent_score }
    ])
  );

  const today = new Date();
  const todayKey = dateKey(today);

  const now = monthQuery && /^\d{4}-\d{2}$/.test(monthQuery) ? monthQuery : monthParam(today.getFullYear(), today.getMonth());
  const [yearStr, monthStr] = now.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;

  const hasEventDay = new Set<string>();
  const liveOrTodayDay = new Set<string>();
  const firstEventIdByDay = new Map<string, string>();

  for (const event of events ?? []) {
    const key = dateKey(new Date(event.starts_at));
    hasEventDay.add(key);
    if (!firstEventIdByDay.has(key)) firstEventIdByDay.set(key, event.id);
    if (gameByEvent.get(event.id)?.status === "live" || key === todayKey) {
      liveOrTodayDay.add(key);
    }
  }

  const gridDays = getMonthGridDays(year, month);
  const monthLabel = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
    new Date(year, month, 1)
  );
  const weekdayLabels = gridDays
    .slice(0, 7)
    .map((d) => new Intl.DateTimeFormat(locale, { weekday: "short" }).format(d.date));

  const prevMonthDate = new Date(year, month - 1, 1);
  const nextMonthDate = new Date(year, month + 1, 1);
  const prevMonthParam = monthParam(prevMonthDate.getFullYear(), prevMonthDate.getMonth());
  const nextMonthParam = monthParam(nextMonthDate.getFullYear(), nextMonthDate.getMonth());

  return (
    <>
      <h1 className="text-xl font-semibold text-slate-900">{t("events.title")}</h1>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <a
            href={`?month=${prevMonthParam}`}
            aria-label={t("events.previousMonth")}
            className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-50"
          >
            ‹
          </a>
          <span className="text-sm font-medium capitalize text-slate-900">{monthLabel}</span>
          <a
            href={`?month=${nextMonthParam}`}
            aria-label={t("events.nextMonth")}
            className="rounded-lg px-2 py-1 text-slate-500 hover:bg-slate-50"
          >
            ›
          </a>
        </div>

        <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-slate-400">
          {weekdayLabels.map((label, i) => (
            <span key={i} className="capitalize">
              {label}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {gridDays.map(({ date, inMonth }) => {
            const key = dateKey(date);
            const isToday = key === todayKey;
            const hasEvent = hasEventDay.has(key);
            const hasLiveOrToday = liveOrTodayDay.has(key);
            const content = (
              <div
                className={`flex flex-col items-center gap-0.5 rounded-lg py-1.5 text-sm ${
                  inMonth ? "text-slate-900" : "text-slate-300"
                } ${isToday ? "ring-1 ring-slate-900" : ""} ${hasEvent ? "hover:bg-slate-50" : ""}`}
              >
                <span aria-label={isToday ? t("events.today") : undefined}>{date.getDate()}</span>
                <span className="flex h-1.5 items-center gap-0.5">
                  {hasEvent && <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />}
                  {hasLiveOrToday && <span className="h-1.5 w-1.5 rounded-full bg-red-600" />}
                </span>
              </div>
            );
            return hasEvent ? (
              <a key={key} href={`#event-${firstEventIdByDay.get(key)}`}>
                {content}
              </a>
            ) : (
              <div key={key}>{content}</div>
            );
          })}
        </div>
      </div>

      {!events || events.length === 0 ? (
        <p className="text-slate-600">{t("events.noUpcomingEvents")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((event) => {
            const game = gameByEvent.get(event.id);
            const isLive = game?.status === "live";
            const isFinal = game?.status === "final";
            const resultColor =
              game && game.ourScore > game.opponentScore
                ? "text-green-600"
                : game && game.ourScore < game.opponentScore
                  ? "text-red-600"
                  : "text-slate-500";
            return (
              <li key={event.id}>
                <a
                  id={`event-${event.id}`}
                  href={`/${locale}/teams/${teamId}/events/${event.id}`}
                  className="flex flex-col gap-1 rounded-lg border border-slate-200 px-4 py-3 hover:bg-slate-50"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-900">
                      {event.title || event.opponent_name || t(`events.type.${event.type}`)}
                    </span>
                    {isLive ? (
                      <span className="flex items-center gap-1 text-xs font-semibold uppercase text-red-600">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-600" />
                        {t("game.live")}
                      </span>
                    ) : isFinal && game ? (
                      <span className="flex items-center gap-1 text-xs font-semibold uppercase text-slate-500">
                        {t("game.final")} | (<span className={resultColor}>{game.ourScore}</span>-
                        {game.opponentScore})
                      </span>
                    ) : (
                      <span className="text-xs text-slate-500">{t(`events.type.${event.type}`)}</span>
                    )}
                  </div>
                  <span className="text-sm text-slate-500">{formatEventDateTime(event.starts_at, locale)}</span>
                  {event.location && <span className="text-xs text-slate-500">{event.location}</span>}
                </a>
              </li>
            );
          })}
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
    </>
  );
}
