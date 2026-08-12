"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";

type GameStatus = "scheduled" | "live" | "final" | "postponed" | "canceled";

type Game = {
  id: string;
  status: GameStatus;
  our_score: number;
  opponent_score: number;
  current_inning: number;
  inning_half: string | null;
  outs: number;
  balls: number;
  strikes: number;
  home_or_away: string | null;
  current_batter_player_id: string | null;
  current_pitcher_player_id: string | null;
};

type RosterPlayer = {
  id: string;
  first_name: string;
  last_name: string;
  jersey_number: string | null;
};

export function GameScorePanel({
  eventId,
  initialGame,
  isApprovedAdmin,
  opponentName,
  roster,
  initialLineup
}: {
  eventId: string;
  initialGame: Game | null;
  isApprovedAdmin: boolean;
  opponentName: string | null;
  roster: RosterPlayer[];
  initialLineup: string[];
}) {
  const t = useTranslations();
  const supabase = createClient();

  const [game, setGame] = useState<Game | null>(initialGame);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tap-to-build working set for the lineup editor, separate from
  // hasSavedLineup so the "next batter" button's visibility reflects what's
  // actually persisted, not whatever the admin has mid-edit -- avoids a
  // reachable LINEUP_EMPTY from tapping "next batter" before saving.
  const [lineupSelection, setLineupSelection] = useState<string[]>(initialLineup);
  const [hasSavedLineup, setHasSavedLineup] = useState(initialLineup.length > 0);

  // Filtered on event_id (not id) because a viewer who loaded this page
  // before the admin started the game has no game id yet to subscribe by --
  // event: "*" covers both the INSERT that start_game produces and every
  // later UPDATE with a single channel.
  useEffect(() => {
    const channel = supabase
      .channel(`game-${eventId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "games", filter: `event_id=eq.${eventId}` },
        (payload) => setGame(payload.new as Game)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  function playerName(id: string | null): string | null {
    if (!id) return null;
    const player = roster.find((p) => p.id === id);
    if (!player) return null;
    return `${player.first_name} ${player.last_name}${player.jersey_number ? ` #${player.jersey_number}` : ""}`;
  }

  async function startGame() {
    setLoading(true);
    setError(null);
    const { data, error: startError } = await supabase.rpc("start_game", { p_event_id: eventId });
    setLoading(false);
    if (startError) {
      setError(t(rpcErrorKey(startError.message)));
      return;
    }
    if (data) setGame(data as Game);
  }

  async function addRun(scoringTeam: "us" | "opponent") {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: runError } = await supabase.rpc("record_score_event", {
      p_game_id: game.id,
      p_runs: 1,
      p_scoring_team: scoringTeam
    });
    setLoading(false);
    if (runError) setError(t(rpcErrorKey(runError.message)));
  }

  async function addCount(eventType: "ball" | "strike" | "out") {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: countError } = await supabase.rpc("record_count_event", {
      p_game_id: game.id,
      p_event_type: eventType
    });
    setLoading(false);
    if (countError) setError(t(rpcErrorKey(countError.message)));
  }

  // Corrects a misclicked ball/strike/out without the +1 path's threshold
  // side effects (no walk, no strikeout-out, no inning advance) -- just
  // decrements that one counter, floored at 0 server-side.
  async function removeCount(eventType: "ball" | "strike" | "out") {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: countError } = await supabase.rpc("record_count_event", {
      p_game_id: game.id,
      p_event_type: eventType,
      p_delta: -1
    });
    setLoading(false);
    if (countError) setError(t(rpcErrorKey(countError.message)));
  }

  async function finalizeGame() {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: finalizeError } = await supabase.rpc("finalize_game", { p_game_id: game.id });
    setLoading(false);
    if (finalizeError) setError(t(rpcErrorKey(finalizeError.message)));
  }

  async function setHomeOrAway(value: "home" | "away") {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: setError_ } = await supabase.rpc("set_home_or_away", {
      p_game_id: game.id,
      p_home_or_away: value
    });
    setLoading(false);
    if (setError_) setError(t(rpcErrorKey(setError_.message)));
  }

  async function nextBatter() {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: advanceError } = await supabase.rpc("advance_batter", { p_game_id: game.id });
    setLoading(false);
    if (advanceError) setError(t(rpcErrorKey(advanceError.message)));
  }

  async function selectPitcher(playerId: string) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: pitcherError } = await supabase.rpc("set_current_pitcher", {
      p_game_id: game.id,
      p_player_id: playerId || null
    });
    setLoading(false);
    if (pitcherError) setError(t(rpcErrorKey(pitcherError.message)));
  }

  function toggleLineupPlayer(playerId: string) {
    setLineupSelection((prev) =>
      prev.includes(playerId) ? prev.filter((id) => id !== playerId) : [...prev, playerId]
    );
  }

  async function saveLineup() {
    if (!game || lineupSelection.length === 0) return;
    setLoading(true);
    setError(null);
    const { error: lineupError } = await supabase.rpc("set_lineup", {
      p_game_id: game.id,
      p_player_ids: lineupSelection
    });
    setLoading(false);
    if (lineupError) {
      setError(t(rpcErrorKey(lineupError.message)));
      return;
    }
    setHasSavedLineup(true);
  }

  if (!game) {
    return (
      <div className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-slate-500">{t("game.title")}</h2>
        <p className="text-slate-600">{t("game.notStartedYet")}</p>
        {isApprovedAdmin && (
          <button
            type="button"
            disabled={loading}
            onClick={startGame}
            className="rounded-lg bg-slate-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {t("game.startGame")}
          </button>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  const opponentLabel = opponentName || t("game.opponent");
  const isLive = game.status === "live";
  const battingName = playerName(game.current_batter_player_id);
  const pitchingName = playerName(game.current_pitcher_player_id);

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-slate-500">{t("game.title")}</h2>

      <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase text-slate-500">
            {t(`game.${game.status}` as "game.live" | "game.final" | "game.scheduled")}
          </span>
          {game.inning_half && (
            <span className="text-xs text-slate-500">
              {t(`game.${game.inning_half}` as "game.top" | "game.bottom")} · {t("game.inning")}{" "}
              {game.current_inning}
            </span>
          )}
        </div>

        <div className="flex items-center justify-between text-2xl font-semibold text-slate-900">
          <div className="flex flex-col items-center">
            <span>{game.our_score}</span>
            <span className="text-xs font-normal text-slate-500">{t("game.us")}</span>
          </div>
          <span className="text-slate-300">–</span>
          <div className="flex flex-col items-center">
            <span>{game.opponent_score}</span>
            <span className="text-xs font-normal text-slate-500">{opponentLabel}</span>
          </div>
        </div>

        {isLive && (
          <div className="flex items-center justify-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              {t("game.outs")}:
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={`h-2 w-2 rounded-full ${i < game.outs ? "bg-slate-900" : "bg-slate-200"}`}
                />
              ))}
            </span>
            <span>
              {t("game.count")}: {game.balls}-{game.strikes}
            </span>
          </div>
        )}

        {(battingName || pitchingName) && (
          <div className="flex flex-col gap-0.5 text-xs text-slate-500">
            {battingName && (
              <span>
                {t("game.batting")}: {battingName}
              </span>
            )}
            {pitchingName && (
              <span>
                {t("game.pitching")}: {pitchingName}
              </span>
            )}
          </div>
        )}
      </div>

      {isLive && isApprovedAdmin && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            {(
              [
                { type: "ball" as const, label: t("game.ball"), value: game.balls },
                { type: "strike" as const, label: t("game.strike"), value: game.strikes },
                { type: "out" as const, label: t("game.out"), value: game.outs }
              ]
            ).map(({ type, label, value }) => (
              <div
                key={type}
                className="flex flex-1 items-center justify-between rounded-lg border border-slate-300 px-2 py-2"
              >
                <button
                  type="button"
                  disabled={loading || value === 0}
                  onClick={() => removeCount(type)}
                  aria-label={`-1 ${label}`}
                  title={`-1 ${label}`}
                  className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-50 disabled:opacity-30"
                >
                  −
                </button>
                <span className="text-sm font-medium text-slate-700">{label}</span>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => addCount(type)}
                  aria-label={`+1 ${label}`}
                  title={`+1 ${label}`}
                  className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                >
                  +
                </button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => addRun("us")}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
            >
              {t("game.addRunUs")}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => addRun("opponent")}
              className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
            >
              {t("game.addRunOpponent")}
            </button>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => setHomeOrAway("home")}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                game.home_or_away === "home"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 text-slate-700"
              }`}
            >
              {t("game.home")}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => setHomeOrAway("away")}
              className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                game.home_or_away === "away"
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 text-slate-700"
              }`}
            >
              {t("game.away")}
            </button>
          </div>

          {hasSavedLineup && (
            <button
              type="button"
              disabled={loading}
              onClick={nextBatter}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
            >
              {t("game.nextBatter")}
            </button>
          )}

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-slate-500">{t("game.pitcherLabel")}</label>
            <select
              value={game.current_pitcher_player_id ?? ""}
              disabled={loading}
              onChange={(e) => selectPitcher(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">{t("game.noPitcherSelected")}</option>
              {roster.map((player) => (
                <option key={player.id} value={player.id}>
                  {player.first_name} {player.last_name}
                  {player.jersey_number ? ` #${player.jersey_number}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-medium text-slate-500">{t("game.lineupTitle")}</p>
            <ul className="flex flex-col gap-1">
              {roster.map((player) => {
                const position = lineupSelection.indexOf(player.id);
                const inLineup = position !== -1;
                return (
                  <li key={player.id}>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => toggleLineupPlayer(player.id)}
                      className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-sm disabled:opacity-50 ${
                        inLineup ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 text-slate-700"
                      }`}
                    >
                      <span>
                        {player.first_name} {player.last_name}
                        {player.jersey_number ? ` #${player.jersey_number}` : ""}
                      </span>
                      {inLineup && <span>{position + 1}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            <button
              type="button"
              disabled={loading || lineupSelection.length === 0}
              onClick={saveLineup}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {t("game.saveLineup")}
            </button>
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={finalizeGame}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {t("game.finalizeGame")}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
