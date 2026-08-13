"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";
import { BaseDiamond } from "@/components/games/base-diamond";
import { notifyGameStartedAction } from "@/app/[locale]/teams/[teamId]/events/[eventId]/actions";
import { queueAction, flushScoreOutbox, pendingScoreCount, type OutboxAction } from "@/lib/offline/db";
import {
  applyCountEvent,
  applyRunEvent,
  applyBaseRunner,
  applyHomeOrAway,
  applyAdvanceBatter,
  applyAdvanceOpponentBatter
} from "@/lib/scoring/engine";

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
  last_pitch_charged_to: string | null;
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

// A network failure resolves with error.code === "" (empty string); a real
// Postgres exception always carries a non-empty SQLSTATE (e.g. "P0001" for
// the plain `raise exception` calls used throughout this app's RPCs). Using
// this instead of matching against rpc-errors.ts's mapped-code list, since
// that list is deliberately incomplete (only covers codes the UI can
// actually trigger today) and "unmapped" would be a fragile stand-in for
// "network failure."
function looksOffline(error: { code?: string } | null): boolean {
  return !navigator.onLine || !error?.code;
}

function isFatalSyncError(err: unknown): boolean {
  return !!(err as { code?: string } | null)?.code;
}

export function GameScorePanel({
  eventId,
  teamId,
  locale,
  initialGame,
  isApprovedAdmin,
  opponentName,
  roster,
  initialLineup,
  initialOpponentLineup
}: {
  eventId: string;
  teamId: string;
  locale: string;
  initialGame: Game | null;
  isApprovedAdmin: boolean;
  opponentName: string | null;
  roster: RosterPlayer[];
  initialLineup: string[];
  initialOpponentLineup: OpponentBatter[];
}) {
  const t = useTranslations();
  const supabase = createClient();

  const [game, setGame] = useState<Game | null>(initialGame);
  const [opponentLineup, setOpponentLineup] = useState<OpponentBatter[]>(initialOpponentLineup);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncFailedCount, setSyncFailedCount] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  const opponentBatterIds = opponentLineup.map((o) => o.id);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Guarded behind `mounted` as cheap insurance against Dexie/IndexedDB
  // running during Next's SSR pass of this client component -- Dexie itself
  // resolves to a null backend under Node rather than throwing, but nothing
  // in this app has exercised that path until this feature, so the guard
  // costs nothing and removes the doubt.
  const pendingCount =
    useLiveQuery(() => (mounted && game ? pendingScoreCount(game.id) : Promise.resolve(0)), [mounted, game?.id]) ?? 0;

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

  // Replays one queued action for real against the server -- used both by
  // the reconnect-flush effect below.
  async function replayAction(action: OutboxAction) {
    switch (action.kind) {
      case "score_count": {
        const { error: rpcError } = await supabase.rpc("record_count_event", {
          p_game_id: action.gameId,
          p_event_type: action.eventType,
          p_delta: action.delta
        });
        if (rpcError) throw rpcError;
        return;
      }
      case "score_run": {
        const { error: rpcError } = await supabase.rpc("record_score_event", {
          p_game_id: action.gameId,
          p_runs: action.runs,
          p_scoring_team: action.scoringTeam
        });
        if (rpcError) throw rpcError;
        return;
      }
      case "score_base": {
        const { error: rpcError } = await supabase.rpc("set_base_runner", {
          p_game_id: action.gameId,
          p_base: action.base,
          p_occupied: action.occupied
        });
        if (rpcError) throw rpcError;
        return;
      }
      case "score_home_or_away": {
        const { error: rpcError } = await supabase.rpc("set_home_or_away", {
          p_game_id: action.gameId,
          p_home_or_away: action.value
        });
        if (rpcError) throw rpcError;
        return;
      }
      case "score_advance_batter": {
        const { error: rpcError } = await supabase.rpc("advance_batter", { p_game_id: action.gameId });
        if (rpcError) throw rpcError;
        return;
      }
      case "score_advance_opponent_batter": {
        const { error: rpcError } = await supabase.rpc("advance_opponent_batter", { p_game_id: action.gameId });
        if (rpcError) throw rpcError;
        return;
      }
      default:
        // rsvp_update/chat_message/snack_claim -- not this component's concern.
        return;
    }
  }

  // Flushes on reconnect, and once on mount in case the app was reloaded
  // while already back online with actions still queued from a prior
  // session.
  useEffect(() => {
    if (!game) return;

    async function flush() {
      const countBefore = await pendingScoreCount(game!.id);
      if (countBefore === 0) return;
      const result = await flushScoreOutbox(game!.id, replayAction, isFatalSyncError);
      if (!result.ok && result.reason === "fatal") {
        setSyncFailedCount(countBefore);
      }
    }

    if (navigator.onLine) flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.id]);

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
    const offlineAction: OutboxAction = { kind: "score_run", gameId: game.id, scoringTeam, runs: 1 };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyRunEvent(game, 1, scoringTeam) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { error: runError } = await supabase.rpc("record_score_event", {
      p_game_id: game.id,
      p_runs: 1,
      p_scoring_team: scoringTeam
    });
    setLoading(false);

    if (runError) {
      if (looksOffline(runError)) {
        setGame({ ...game, ...applyRunEvent(game, 1, scoringTeam) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(runError.message)));
    }
  }

  // Corrects a misclicked run without touching status/other fields. Floored
  // at 0 server-side (0015_run_removal.sql).
  async function removeRun(scoringTeam: "us" | "opponent") {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_run", gameId: game.id, scoringTeam, runs: -1 };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyRunEvent(game, -1, scoringTeam) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { error: runError } = await supabase.rpc("record_score_event", {
      p_game_id: game.id,
      p_runs: -1,
      p_scoring_team: scoringTeam
    });
    setLoading(false);

    if (runError) {
      if (looksOffline(runError)) {
        setGame({ ...game, ...applyRunEvent(game, -1, scoringTeam) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(runError.message)));
    }
  }

  async function addCount(eventType: "ball" | "strike" | "out") {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_count", gameId: game.id, eventType, delta: 1 };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyCountEvent(game, eventType, 1, initialLineup, opponentBatterIds) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { data, error: countError } = await supabase.rpc("record_count_event", {
      p_game_id: game.id,
      p_event_type: eventType
    });
    setLoading(false);

    if (countError) {
      if (looksOffline(countError)) {
        setGame({ ...game, ...applyCountEvent(game, eventType, 1, initialLineup, opponentBatterIds) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(countError.message)));
      return;
    }
    if (data) setGame(data as Game);
  }

  // Corrects a misclicked ball/strike/out without the +1 path's threshold
  // side effects (no walk, no strikeout-out, no inning advance) -- just
  // decrements that one counter, floored at 0 server-side.
  async function removeCount(eventType: "ball" | "strike" | "out") {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_count", gameId: game.id, eventType, delta: -1 };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyCountEvent(game, eventType, -1, initialLineup, opponentBatterIds) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { data, error: countError } = await supabase.rpc("record_count_event", {
      p_game_id: game.id,
      p_event_type: eventType,
      p_delta: -1
    });
    setLoading(false);

    if (countError) {
      if (looksOffline(countError)) {
        setGame({ ...game, ...applyCountEvent(game, eventType, -1, initialLineup, opponentBatterIds) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(countError.message)));
      return;
    }
    if (data) setGame(data as Game);
  }

  async function setBaseRunner(base: "first" | "second" | "third", occupied: boolean) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_base", gameId: game.id, base, occupied };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyBaseRunner(game, base, occupied) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { error: baseError } = await supabase.rpc("set_base_runner", {
      p_game_id: game.id,
      p_base: base,
      p_occupied: occupied
    });
    setLoading(false);

    if (baseError) {
      if (looksOffline(baseError)) {
        setGame({ ...game, ...applyBaseRunner(game, base, occupied) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(baseError.message)));
    }
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
    const offlineAction: OutboxAction = { kind: "score_home_or_away", gameId: game.id, value };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyHomeOrAway(game, value) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { error: setError_ } = await supabase.rpc("set_home_or_away", {
      p_game_id: game.id,
      p_home_or_away: value
    });
    setLoading(false);

    if (setError_) {
      if (looksOffline(setError_)) {
        setGame({ ...game, ...applyHomeOrAway(game, value) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(setError_.message)));
    }
  }

  async function nextBatter() {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_advance_batter", gameId: game.id };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyAdvanceBatter(game, initialLineup) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { error: advanceError } = await supabase.rpc("advance_batter", { p_game_id: game.id });
    setLoading(false);

    if (advanceError) {
      if (looksOffline(advanceError)) {
        setGame({ ...game, ...applyAdvanceBatter(game, initialLineup) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(advanceError.message)));
    }
  }

  async function nextOpponentBatter() {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_advance_opponent_batter", gameId: game.id };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyAdvanceOpponentBatter(game, opponentBatterIds) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { error: advanceError } = await supabase.rpc("advance_opponent_batter", { p_game_id: game.id });
    setLoading(false);

    if (advanceError) {
      if (looksOffline(advanceError)) {
        setGame({ ...game, ...applyAdvanceOpponentBatter(game, opponentBatterIds) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(advanceError.message)));
    }
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

      {pendingCount > 0 && (
        <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-800">
          {t("game.pendingSync", { count: pendingCount })}
        </p>
      )}
      {syncFailedCount !== null && (
        <p className="rounded-lg bg-red-100 px-3 py-2 text-sm font-medium text-red-800">
          {t("game.syncFailed", { count: syncFailedCount })}
        </p>
      )}

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
            {(
              [
                { team: "us" as const, label: t("game.addRunUs"), value: game.our_score },
                { team: "opponent" as const, label: t("game.addRunOpponent"), value: game.opponent_score }
              ]
            ).map(({ team, label, value }) => (
              <div
                key={team}
                className="flex flex-1 items-center justify-between rounded-lg border border-slate-300 px-2 py-2"
              >
                <button
                  type="button"
                  disabled={loading || value === 0}
                  onClick={() => removeRun(team)}
                  aria-label={t("game.removeRunAriaLabel", { team: label })}
                  title={t("game.removeRunAriaLabel", { team: label })}
                  className="flex h-6 w-6 items-center justify-center rounded text-slate-500 hover:bg-slate-50 disabled:opacity-30"
                >
                  −
                </button>
                <span className="text-sm font-medium text-slate-700">{label}</span>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => addRun(team)}
                  aria-label={label}
                  title={label}
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
            disabled={loading || pendingCount > 0}
            onClick={finalizeGame}
            title={pendingCount > 0 ? t("game.finalizeDisabledPendingSync") : undefined}
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
