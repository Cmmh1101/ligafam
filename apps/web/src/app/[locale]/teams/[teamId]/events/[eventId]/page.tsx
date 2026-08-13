import { getTranslations, getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatEventDateTime } from "@/lib/datetime";
import { RsvpToggle, RsvpStatusBadge } from "@/components/events/rsvp-toggle";
import { GameScorePanel } from "@/components/games/game-score-panel";
import { LineupSetup } from "@/components/games/lineup-setup";
import { EventTabs } from "@/components/events/event-tabs";
import { claimSnackAction, deleteSnackAction, deleteEventAction } from "./actions";

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
    .select("id, role, status")
    .eq("team_id", teamId)
    .eq("user_id", user.id)
    .maybeSingle();

  const isApprovedMember = membership?.status === "approved";
  const isApprovedAdmin = isApprovedMember && membership?.role === "admin";
  const isApprovedFamily = isApprovedMember && membership?.role === "family";

  // The caller's own family_links, fetched once regardless of event type or
  // role -- owns_player_via_family() (backing both the RSVP upsert and the
  // snack RLS policies) never checks role, only that the caller's own
  // team_member row has a family_links entry. Used for the RSVP toggle
  // (by player_id) and for which snacks the caller is allowed to delete
  // (by family_link id).
  let myLinkedPlayerIds = new Set<string>();
  let myFamilyLinkIds = new Set<string>();

  if (isApprovedMember && membership) {
    const { data: links } = await supabase
      .from("family_links")
      .select("id, player_id")
      .eq("team_member_id", membership.id);
    myLinkedPlayerIds = new Set((links ?? []).map((l) => l.player_id));
    myFamilyLinkIds = new Set((links ?? []).map((l) => l.id));
  }

  // --- Live scoring section: only queried for game-type events, and only
  // for approved members (matches the read-access role table: fan/family
  // get read-only scores, admin gets read/write via GameScorePanel's own
  // admin-gated controls).
  const { data: game } =
    event.type === "game" && isApprovedMember
      ? await supabase
          .from("games")
          .select(
            "id, status, our_score, opponent_score, current_inning, inning_half, outs, balls, strikes, home_or_away, current_batter_player_id, current_pitcher_player_id, opponent_pitcher_name, opponent_pitcher_number, current_opponent_batter_id, our_pitcher_pitch_count, opponent_pitcher_pitch_count, runner_on_first, runner_on_second, runner_on_third"
          )
          .eq("event_id", eventId)
          .maybeSingle()
      : { data: null };

  // Active roster for the batting-order/pitcher pickers and for resolving
  // current_batter_player_id/current_pitcher_player_id into names for every
  // viewer, not just the admin editing them. Independently scoped from the
  // RSVP roster query below (different, broader gate: any approved member,
  // not just admin/family), so kept separate rather than reusing that query.
  const { data: gameSeason } =
    event.type === "game" && isApprovedMember
      ? await supabase.from("seasons").select("id").eq("team_id", teamId).eq("is_active", true).maybeSingle()
      : { data: null };

  const { data: gameRosterRows } = gameSeason
    ? await supabase
        .from("season_rosters")
        .select("players(id, first_name, last_name, jersey_number)")
        .eq("season_id", gameSeason.id)
        .eq("active", true)
    : { data: [] };

  const gameRoster = (gameRosterRows ?? []).flatMap((row) => {
    const player = row.players as unknown as
      | { id: string; first_name: string; last_name: string; jersey_number: string | null }
      | null;
    return player ? [player] : [];
  });

  const { data: lineupRows } = game
    ? await supabase
        .from("game_lineup")
        .select("player_id")
        .eq("game_id", game.id)
        .order("batting_order", { ascending: true })
    : { data: [] };

  const initialLineup = (lineupRows ?? []).map((row) => row.player_id as string);

  const { data: opponentLineupRows } = game
    ? await supabase
        .from("game_opponent_lineup")
        .select("id, batting_order, display_name, jersey_number")
        .eq("game_id", game.id)
        .order("batting_order", { ascending: true })
    : { data: [] };

  const initialOpponentLineup = opponentLineupRows ?? [];

  // --- RSVP section: roster-driven, LEFT JOIN'd against event_rsvps in JS
  // (not a single PostgREST query) so a player added to the roster after
  // this event existed still shows up as no_response instead of vanishing.
  type RosterRow = { player_id: string; first_name: string; last_name: string; status: RsvpStatus };
  let rosterRows: RosterRow[] = [];

  if (event.type !== "other" && (isApprovedAdmin || isApprovedFamily)) {
    const { data: season } = await supabase
      .from("seasons")
      .select("id")
      .eq("team_id", teamId)
      .eq("is_active", true)
      .maybeSingle();

    const playerIds = isApprovedFamily ? Array.from(myLinkedPlayerIds) : null;

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
    const familyLinkId = row.family_link_id as string | null;
    return {
      id: row.id as string,
      item: row.item as string,
      playerName: player ? `${player.first_name} ${player.last_name}` : null,
      canDelete: isApprovedAdmin || (familyLinkId !== null && myFamilyLinkIds.has(familyLinkId))
    };
  });

  const claimSnack = claimSnackAction.bind(null, locale, teamId, eventId);
  const deleteSnack = deleteSnackAction.bind(null, locale, teamId, eventId);
  const deleteEvent = deleteEventAction.bind(null, locale, teamId, eventId);

  const rsvpSection = event.type !== "other" && (isApprovedAdmin || isApprovedFamily) && (
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
                <RsvpToggle eventId={eventId} playerId={row.player_id} currentStatus={row.status} userId={user.id} />
              ) : (
                <RsvpStatusBadge status={row.status} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const snacksSection = isApprovedMember && (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-slate-500">{t("snacks.title")}</h2>

      {snacks.length === 0 ? (
        <p className="text-slate-600">{t("snacks.noSnacksYet")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {snacks.map((snack) => {
            const deleteThisSnack = deleteSnack.bind(null, snack.id);
            return (
              <li
                key={snack.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-4 py-3"
              >
                <div className="flex flex-col">
                  <span className="text-slate-900">{snack.item}</span>
                  <span className="text-xs text-slate-500">
                    {t("snacks.forPlayer")}: {snack.playerName || t("snacks.byAdmin")}
                  </span>
                </div>
                {snack.canDelete && (
                  <form action={deleteThisSnack}>
                    <button
                      type="submit"
                      className="text-xs font-medium text-slate-500 underline hover:text-slate-700"
                    >
                      {t("common.delete")}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
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
  );

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-slate-900">
          {event.title || event.opponent_name || t(`events.type.${event.type}`)}
        </h1>
        <p className="text-sm text-slate-500">{formatEventDateTime(event.starts_at, locale)}</p>
        {event.location && <p className="text-sm text-slate-500">{event.location}</p>}
        {isApprovedAdmin && (
          <div className="flex gap-3 pt-1">
            <a
              href={`/${locale}/teams/${teamId}/events/${eventId}/edit`}
              className="text-xs font-medium text-slate-500 underline hover:text-slate-700"
            >
              {t("common.edit")}
            </a>
            <form action={deleteEvent}>
              <button
                type="submit"
                className="text-xs font-medium text-slate-500 underline hover:text-slate-700"
              >
                {t("common.delete")}
              </button>
            </form>
          </div>
        )}
      </header>

      {event.type === "game" && isApprovedMember ? (
        <EventTabs
          boardContent={
            <GameScorePanel
              eventId={eventId}
              teamId={teamId}
              locale={locale}
              initialGame={game}
              isApprovedAdmin={isApprovedAdmin}
              opponentName={event.opponent_name}
              roster={gameRoster}
              initialOpponentLineup={initialOpponentLineup}
            />
          }
          rosterContent={
            <>
              {rsvpSection}
              {isApprovedAdmin && (
                <LineupSetup
                  eventId={eventId}
                  initialGame={game}
                  roster={gameRoster}
                  initialLineup={initialLineup}
                  initialOpponentLineup={initialOpponentLineup}
                />
              )}
            </>
          }
          snacksContent={snacksSection}
        />
      ) : (
        <>
          {rsvpSection}
          {snacksSection}
        </>
      )}
    </>
  );
}
