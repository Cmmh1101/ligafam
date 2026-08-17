"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";

type RosterPlayer = {
  id: string;
  first_name: string;
  last_name: string;
  jersey_number: string | null;
};

type PlateAppearanceRow = {
  side: string;
  batter_player_id: string | null;
  pitcher_player_id: string | null;
  outcome: string;
  rbi: number;
};

type RunScoredRow = {
  side: string;
  scorer_player_id: string | null;
  credited_pitcher_id: string | null;
};

const HIT_OUTCOMES = new Set(["single", "double", "triple", "home_run"]);

function formatAvg(hits: number, atBats: number): string {
  if (atBats === 0) return "-";
  return (hits / atBats).toFixed(3).replace(/^0/, "");
}

function formatIp(outs: number): string {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

// No stored per-game aggregate -- game_plate_appearances/game_runs_scored
// rows are cheap enough to fetch and reduce client-side for a single game.
// Neither table is realtime-published (matches the game_opponent_lineup
// precedent), so this piggybacks a re-fetch off the already-realtime
// `games` row changing, same pattern game-score-panel.tsx uses for the
// opponent lineup.
export function GameStatsView({
  eventId,
  gameId,
  roster
}: {
  eventId: string;
  gameId: string | null;
  roster: RosterPlayer[];
}) {
  const t = useTranslations();
  const supabase = createClient();
  const [currentGameId, setCurrentGameId] = useState<string | null>(gameId);
  const [plateAppearances, setPlateAppearances] = useState<PlateAppearanceRow[]>([]);
  const [runsScored, setRunsScored] = useState<RunScoredRow[]>([]);

  // The server-rendered `gameId` prop reflects page-load time -- if the
  // admin starts the game (on the Marcador tab) in the same session
  // without reloading, that prop stays stale forever (Server Components
  // don't re-render on client-side state changes). Same event_id-filtered
  // subscription pattern LineupSetup uses to pick up the game's id as soon
  // as start_game creates it.
  useEffect(() => {
    if (currentGameId) return;
    const channel = supabase
      .channel(`game-stats-init-${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "games", filter: `event_id=eq.${eventId}` },
        (payload) => setCurrentGameId((payload.new as { id: string }).id)
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, currentGameId]);

  useEffect(() => {
    if (!currentGameId) return;

    async function load() {
      const [{ data: paData }, { data: runData }] = await Promise.all([
        supabase
          .from("game_plate_appearances")
          .select("side, batter_player_id, pitcher_player_id, outcome, rbi")
          .eq("game_id", currentGameId as string),
        supabase
          .from("game_runs_scored")
          .select("side, scorer_player_id, credited_pitcher_id")
          .eq("game_id", currentGameId as string)
      ]);
      setPlateAppearances(paData ?? []);
      setRunsScored(runData ?? []);
    }

    load();

    const channel = supabase
      .channel(`game-stats-${eventId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "games", filter: `event_id=eq.${eventId}` },
        () => load()
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGameId]);

  function playerName(id: string): string {
    const player = roster.find((p) => p.id === id);
    if (!player) return "?";
    return `${player.first_name} ${player.last_name}${player.jersey_number ? ` #${player.jersey_number}` : ""}`;
  }

  if (!currentGameId) {
    return <p className="text-slate-600">{t("game.notStartedYet")}</p>;
  }

  const battingByPlayer = new Map<
    string,
    { ab: number; h: number; doubles: number; triples: number; hr: number; bb: number; k: number; rbi: number }
  >();
  const pitchingByPlayer = new Map<string, { outs: number; k: number; bb: number; h: number }>();

  for (const pa of plateAppearances) {
    if (pa.side === "our" && pa.batter_player_id) {
      const row = battingByPlayer.get(pa.batter_player_id) ?? {
        ab: 0,
        h: 0,
        doubles: 0,
        triples: 0,
        hr: 0,
        bb: 0,
        k: 0,
        rbi: 0
      };
      if (pa.outcome !== "walk") row.ab += 1;
      if (HIT_OUTCOMES.has(pa.outcome)) row.h += 1;
      if (pa.outcome === "double") row.doubles += 1;
      if (pa.outcome === "triple") row.triples += 1;
      if (pa.outcome === "home_run") row.hr += 1;
      if (pa.outcome === "walk") row.bb += 1;
      if (pa.outcome === "strikeout") row.k += 1;
      row.rbi += pa.rbi;
      battingByPlayer.set(pa.batter_player_id, row);
    } else if (pa.side === "opponent" && pa.pitcher_player_id) {
      const row = pitchingByPlayer.get(pa.pitcher_player_id) ?? { outs: 0, k: 0, bb: 0, h: 0 };
      if (pa.outcome === "strikeout" || pa.outcome === "out") row.outs += 1;
      if (pa.outcome === "strikeout") row.k += 1;
      if (pa.outcome === "walk") row.bb += 1;
      if (HIT_OUTCOMES.has(pa.outcome)) row.h += 1;
      pitchingByPlayer.set(pa.pitcher_player_id, row);
    }
  }

  const runsByPlayer = new Map<string, number>();
  const runsAllowedByPitcher = new Map<string, number>();
  for (const run of runsScored) {
    if (run.side === "our" && run.scorer_player_id) {
      runsByPlayer.set(run.scorer_player_id, (runsByPlayer.get(run.scorer_player_id) ?? 0) + 1);
    } else if (run.side === "opponent" && run.credited_pitcher_id) {
      runsAllowedByPitcher.set(run.credited_pitcher_id, (runsAllowedByPitcher.get(run.credited_pitcher_id) ?? 0) + 1);
    }
  }

  const battingRows = Array.from(battingByPlayer.entries()).map(([playerId, stats]) => ({
    playerId,
    ...stats,
    r: runsByPlayer.get(playerId) ?? 0,
    avg: formatAvg(stats.h, stats.ab)
  }));

  const pitchingRows = Array.from(pitchingByPlayer.entries()).map(([playerId, stats]) => ({
    playerId,
    ...stats,
    r: runsAllowedByPitcher.get(playerId) ?? 0
  }));

  if (battingRows.length === 0 && pitchingRows.length === 0) {
    return <p className="text-slate-600">{t("game.stats.noDataYet")}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {battingRows.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-slate-500">{t("game.stats.battingTitle")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="pr-2 font-medium">{t("game.stats.player")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.abAbbrev")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.hAbbrev")}</th>
                  <th className="px-1.5 text-center font-medium">2B</th>
                  <th className="px-1.5 text-center font-medium">3B</th>
                  <th className="px-1.5 text-center font-medium">HR</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.bbAbbrev")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.kAbbrev")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.rAbbrev")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.rbiAbbrev")}</th>
                  <th className="pl-1.5 text-center font-medium">{t("game.stats.avgAbbrev")}</th>
                </tr>
              </thead>
              <tbody>
                {battingRows.map((row) => (
                  <tr key={row.playerId} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-900">{playerName(row.playerId)}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.ab}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.h}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.doubles}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.triples}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.hr}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.bb}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.k}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.r}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.rbi}</td>
                    <td className="pl-1.5 text-center text-slate-700">{row.avg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {pitchingRows.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-slate-500">{t("game.stats.pitchingTitle")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="pr-2 font-medium">{t("game.stats.player")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.ipAbbrev")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.kAbbrev")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.bbAbbrev")}</th>
                  <th className="px-1.5 text-center font-medium">{t("game.stats.hAbbrev")}</th>
                  <th className="pl-1.5 text-center font-medium">{t("game.stats.rAbbrev")}</th>
                </tr>
              </thead>
              <tbody>
                {pitchingRows.map((row) => (
                  <tr key={row.playerId} className="border-t border-slate-100">
                    <td className="py-1.5 pr-2 text-slate-900">{playerName(row.playerId)}</td>
                    <td className="px-1.5 text-center text-slate-700">{formatIp(row.outs)}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.k}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.bb}</td>
                    <td className="px-1.5 text-center text-slate-700">{row.h}</td>
                    <td className="pl-1.5 text-center text-slate-700">{row.r}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
