import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatEventDateTime } from "@/lib/datetime";
import { RsvpToggle, RsvpStatusBadge } from "@/components/events/rsvp-toggle";
import { claimSnackAction } from "./actions";

type RsvpStatus = "yes" | "no" | "maybe" | "no_response";

export default async function EventDetailPage({
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
    .select("id, type, title, opponent_name, location, starts_at")
    .eq("id", eventId)
    .eq("team_id", teamId)
    .maybeSingle();

  if (!event) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <p className="text-slate-600">{t("events.notFound")}</p>
        <a href={`/${locale}/teams/${teamId}/events`} className="text-sm text-slate-500 underline">
          {t("common.back")}
        </a>
      </main>
    );
  }

  const { data: membership } = await supabase
    .from("team_members")
    .select("id, role, status")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  const isApprovedMember = membership?.status === "approved";
  const isApprovedAdmin = isApprovedMember && membership?.role === "admin";
  const isApprovedFamily = isApprovedMember && membership?.role === "family";

  // --- RSVP section: roster-driven, LEFT JOIN'd against event_rsvps in JS
  // (not a single PostgREST query) so a player added to the roster after
  // this event existed still shows up as no_response instead of vanishing.
  //
  // myLinkedPlayerIds is independent of role: owns_player_via_family() (the
  // RLS check backing the RsvpToggle's upsert) never checks role, only that
  // the caller's own team_member row has a family_links entry for that
  // player. An admin can link themselves to a player on the roster page
  // just like a family member can, so they get the same toggle for their
  // own linked player(s) here, alongside read-only status for everyone else.
  type RosterRow = { player_id: string; first_name: string; last_name: string; status: RsvpStatus };
  let rosterRows: RosterRow[] = [];
  let myLinkedPlayerIds = new Set<string>();

  if (event.type !== "other" && (isApprovedAdmin || isApprovedFamily)) {
    const { data: season } = await supabase
      .from("seasons")
      .select("id")
      .eq("team_id", teamId)
      .eq("is_active", true)
      .maybeSingle();

    let playerIds: string[] | null = null;

    if (membership) {
      const { data: links } = await supabase
        .from("family_links")
        .select("player_id")
        .eq("team_member_id", membership.id);
      const linkedIds = (links ?? []).map((l) => l.player_id);
      myLinkedPlayerIds = new Set(linkedIds);
      if (isApprovedFamily) {
        playerIds = linkedIds;
      }
    }

    if (season && (isApprovedAdmin || (playerIds && playerIds.length > 0))) {
      let rosterQuery = supabase
        .from("season_rosters")
        .select("player_id, players(id, first_name, last_name)")
        .eq("season_id", season.id)
        .eq("active", true);

      if (playerIds) {
        rosterQuery = rosterQuery.in("player_id", playerIds);
      }

      const { data: roster } = await rosterQuery;

      const { data: rsvps } = await supabase
        .from("event_rsvps")
        .select("player_id, status")
        .eq("event_id", eventId);

      const statusByPlayer = new Map((rsvps ?? []).map((r) => [r.player_id, r.status as RsvpStatus]));

      rosterRows = (roster ?? []).flatMap((row) => {
        const player = row.players as unknown as { id: string; first_name: string; last_name: string } | null;
        if (!player) return [];
        return [
          {
            player_id: player.id,
            first_name: player.first_name,
            last_name: player.last_name,
            status: statusByPlayer.get(player.id) ?? "no_response"
          }
        ];
      });
    }
  }

  // --- Snacks section: everyone approved reads; admin/family can claim.
  // Player name comes from family_links -> players (the specific kid that
  // signup is tied to), not the signing-up adult's own name. This also
  // avoids embedding through team_members -> profiles, which PostgREST
  // rejects (PGRST201): team_members has two FKs to profiles (user_id and
  // decided_by), so that embed is ambiguous and silently fails the whole
  // query -- which is why the list was showing empty despite real rows
  // existing.
  const { data: snackRows } = isApprovedMember
    ? await supabase
        .from("snack_assignments")
        .select("id, item, family_link_id, family_links(players(first_name, last_name))")
        .eq("event_id", eventId)
        .order("created_at", { ascending: true })
    : { data: [] };

  const snacks = (snackRows ?? []).map((row) => {
    const player = (
      row.family_links as unknown as { players: { first_name: string; last_name: string } | null } | null
    )?.players;
    return {
      id: row.id as string,
      item: row.item as string,
      playerName: player ? `${player.first_name} ${player.last_name}` : null
    };
  });

  const claimSnack = claimSnackAction.bind(null, locale, teamId, eventId);

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex flex-col gap-1">
        <a href={`/${locale}/teams/${teamId}/events`} className="text-sm text-slate-500 underline">
          {t("events.title")}
        </a>
        <h1 className="text-xl font-semibold text-slate-900">
          {event.title || event.opponent_name || t(`events.type.${event.type}`)}
        </h1>
        <p className="text-sm text-slate-500">{formatEventDateTime(event.starts_at, locale)}</p>
        {event.location && <p className="text-sm text-slate-500">{event.location}</p>}
      </header>

      {event.type !== "other" && (isApprovedAdmin || isApprovedFamily) && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-slate-500">{t("events.rsvpSection")}</h2>

          {rosterRows.length === 0 ? (
            <p className="text-slate-600">{t("events.noRosterYet")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {rosterRows.map((row) => (
                <li
                  key={row.player_id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                >
                  <span className="text-slate-900">
                    {row.first_name} {row.last_name}
                  </span>
                  {myLinkedPlayerIds.has(row.player_id) ? (
                    <RsvpToggle
                      eventId={eventId}
                      playerId={row.player_id}
                      currentStatus={row.status}
                      userId={user.id}
                    />
                  ) : (
                    <RsvpStatusBadge status={row.status} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isApprovedMember && (
        <div className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-slate-500">{t("snacks.title")}</h2>

          {snacks.length === 0 ? (
            <p className="text-slate-600">{t("snacks.noSnacksYet")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {snacks.map((snack) => (
                <li
                  key={snack.id}
                  className="flex items-center justify-between rounded-lg border border-slate-200 px-4 py-3"
                >
                  <span className="text-slate-900">{snack.item}</span>
                  <span className="text-xs text-slate-500">
                    {t("snacks.forPlayer")}: {snack.playerName || t("snacks.byAdmin")}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {(isApprovedAdmin || isApprovedFamily) && (
            <form action={claimSnack} className="flex gap-2">
              <input
                name="item"
                type="text"
                required
                placeholder={t("snacks.itemPlaceholder")}
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
              />
              <button type="submit" className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white">
                {t("snacks.claim")}
              </button>
            </form>
          )}
        </div>
      )}
    </main>
  );
}
