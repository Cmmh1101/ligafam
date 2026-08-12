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
};

export function GameScorePanel({
  eventId,
  initialGame,
  isApprovedAdmin,
  opponentName
}: {
  eventId: string;
  initialGame: Game | null;
  isApprovedAdmin: boolean;
  opponentName: string | null;
}) {
  const t = useTranslations();
  const supabase = createClient();

  const [game, setGame] = useState<Game | null>(initialGame);
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
