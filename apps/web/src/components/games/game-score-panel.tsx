"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";
import { BaseDiamond } from "@/components/games/base-diamond";
import { notifyGameStartedAction } from "@/app/[locale]/teams/[teamId]/events/[eventId]/actions";

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
  opponent_pitcher_name: string | null;
  opponent_pitcher_number: string | null;
  current_opponent_batter_id: string | null;
  our_pitcher_pitch_count: number;
  opponent_pitcher_pitch_count: number;
  runner_on_first: boolean;
  runner_on_second: boolean;
  runner_on_third: boolean;
};

type RosterPlayer = {
  id: string;
  first_name: string;
  last_name: string;
  jersey_number: string | null;
};

type OpponentBatter = {
  id: string;
  batting_order: number;
  display_name: string | null;
  jersey_number: string | null;
};

export function GameScorePanel({
  eventId,
  teamId,
  locale,
  initialGame,
  isApprovedAdmin,
  opponentName,
  roster,
  initialOpponentLineup
}: {
  eventId: string;
  teamId: string;
  locale: string;
  initialGame: Game | null;
  isApprovedAdmin: boolean;
  opponentName: string | null;
  roster: RosterPlayer[];
  initialOpponentLineup: OpponentBatter[];
}) {
  const t = useTranslations();
  const supabase = createClient();

  const [game, setGame] = useState<Game | null>(initialGame);
  const [opponentLineup, setOpponentLineup] = useState<OpponentBatter[]>(initialOpponentLineup);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // game_opponent_lineup isn't itself realtime-published (its full list only
  // matters to the admin editing it on the Roster tab), but this component
  // still needs an up-to-date copy to resolve the opponent's current
  // batter's name -- set_opponent_lineup always assigns a fresh
  // current_opponent_batter_id on every save, so a change there (which IS
  // realtime, as part of `games`) is a reliable signal to re-fetch the
  // small opponent list via a plain query, without a second channel.
  useEffect(() => {
    if (!game?.id) return;
    supabase
      .from("game_opponent_lineup")
      .select("id, batting_order, display_name, jersey_number")
      .eq("game_id", game.id)
      .order("batting_order", { ascending: true })
      .then(({ data }) => {
        if (data) setOpponentLineup(data);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id, game?.current_opponent_batter_id]);

  function playerName(id: string | null): string | null {
    if (!id) return null;
    const player = roster.find((p) => p.id === id);
    if (!player) return null;
    return `${player.first_name} ${player.last_name}${player.jersey_number ? ` #${player.jersey_number}` : ""}`;
  }

  function opponentBatterName(id: string | null): string | null {
    if (!id) return null;
    const batter = opponentLineup.find((o) => o.id === id);
    if (!batter) return null;
    if (batter.display_name || batter.jersey_number) {
      return `${batter.display_name ?? ""}${batter.jersey_number ? ` #${batter.jersey_number}` : ""}`.trim();
    }
    return `${t("game.opponentBatting")} #${batter.batting_order}`;
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
    if (data) {
      setGame(data as Game);
      notifyGameStartedAction(teamId, eventId, locale).catch(() => {});
    }
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

  async function setBaseRunner(base: "first" | "second" | "third", occupied: boolean) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: baseError } = await supabase.rpc("set_base_runner", {
      p_game_id: game.id,
      p_base: base,
      p_occupied: occupied
    });
    setLoading(false);
    if (baseError) setError(t(rpcErrorKey(baseError.message)));
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

  async function nextOpponentBatter() {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: advanceError } = await supabase.rpc("advance_opponent_batter", { p_game_id: game.id });
    setLoading(false);
    if (advanceError) setError(t(rpcErrorKey(advanceError.message)));
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

  // Whose half is it -- home bats bottom, away bats top. Unknown (null)
  // until home/away is set, in which case neither line is shown rather
  // than guessing.
  const isOurHalf =
    game.home_or_away !== null &&
    ((game.inning_half === "bottom" && game.home_or_away === "home") ||
      (game.inning_half === "top" && game.home_or_away === "away"));

  const showBattingIndicator = game.home_or_away !== null;

  let battingDisplay: string | null = null;
  let pitchingDisplay: string | null = null;
  let pitchCount: number | null = null;
  if (game.home_or_away !== null) {
    if (isOurHalf) {
      battingDisplay = playerName(game.current_batter_player_id);
      pitchingDisplay =
        game.opponent_pitcher_name || game.opponent_pitcher_number
          ? `${game.opponent_pitcher_name ?? ""}${
              game.opponent_pitcher_number ? ` #${game.opponent_pitcher_number}` : ""
            }`.trim()
          : t("game.opponentPitcherUnset");
      pitchCount = game.opponent_pitcher_pitch_count;
    } else {
      battingDisplay = opponentBatterName(game.current_opponent_batter_id);
      pitchingDisplay = playerName(game.current_pitcher_player_id);
      pitchCount = game.our_pitcher_pitch_count;
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-slate-500">{t("game.title")}</h2>

      <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase text-slate-500">
            {isLive && <span className="h-2 w-2 animate-pulse rounded-full bg-red-600" />}
            {t(`game.${game.status}` as "game.live" | "game.final" | "game.scheduled")}
          </span>
          {game.inning_half && (
            <span className="text-xs text-slate-500">
              {t(`game.${game.inning_half}` as "game.top" | "game.bottom")} · {t("game.inning")}{" "}
              {game.current_inning}
            </span>
          )}
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-2xl font-semibold text-slate-900">
          <div className="flex flex-col items-center">
            <span>{game.our_score}</span>
            <span className="flex items-center gap-1 text-xs font-normal text-slate-500">
              {showBattingIndicator && isOurHalf && (
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-label={t("game.battingNowLabel")} />
              )}
              {t("game.us")}
            </span>
          </div>

          {isLive ? (
            <BaseDiamond
              runnerOnFirst={game.runner_on_first}
              runnerOnSecond={game.runner_on_second}
              runnerOnThird={game.runner_on_third}
              onToggleBase={isApprovedAdmin ? setBaseRunner : undefined}
            />
          ) : (
            <span className="text-slate-300">–</span>
          )}

          <div className="flex flex-col items-center">
            <span>{game.opponent_score}</span>
            <span className="flex items-center gap-1 text-xs font-normal text-slate-500">
              {showBattingIndicator && !isOurHalf && (
                <span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-label={t("game.battingNowLabel")} />
              )}
              {opponentLabel}
            </span>
          </div>
        </div>

        {isLive && (
          <div className="flex items-center justify-center gap-6 text-lg font-medium text-slate-700">
            <span className="flex items-center gap-1.5">
              {t("game.outs")}:
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={`h-3 w-3 rounded-full ${i < game.outs ? "bg-slate-900" : "bg-slate-200"}`}
                />
              ))}
            </span>
            <span>
              {t("game.count")}: {game.balls}-{game.strikes}
            </span>
          </div>
        )}

        {(battingDisplay || pitchingDisplay) && (
          <div className="flex flex-col gap-1 text-base text-slate-700">
            {battingDisplay && (
              <span>
                {t("game.batting")}: {battingDisplay}
              </span>
            )}
            {pitchingDisplay && (
              <span>
                {t("game.pitching")}: {pitchingDisplay}
                {pitchCount !== null &&
                  ` | ${t("game.pitchCountAbbrev")}: ${String(pitchCount).padStart(2, "0")}`}
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

          <div className="flex gap-2">
            {game.current_batter_player_id !== null && (
              <button
                type="button"
                disabled={loading}
                onClick={nextBatter}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
              >
                {t("game.nextBatter")}
              </button>
            )}
            {game.current_opponent_batter_id !== null && (
              <button
                type="button"
                disabled={loading}
                onClick={nextOpponentBatter}
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
              >
                {t("game.nextOpponentBatter")}
              </button>
            )}
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
