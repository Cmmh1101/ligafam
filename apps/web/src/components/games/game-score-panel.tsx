"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";
import { BaseDiamond, type FielderPosition } from "@/components/games/base-diamond";
import { notifyGameStartedAction, notifyGameFinalizedAction } from "@/app/[locale]/teams/[teamId]/events/[eventId]/actions";
import { queueAction, flushScoreOutbox, pendingScoreCount, type OutboxAction } from "@/lib/offline/db";
import { useToast } from "@/components/toast/toast-context";
import {
  applyCountEvent,
  applyRunEvent,
  applyBaseRunner,
  applyHomeOrAway,
  applyAdvanceBatter,
  applyAdvanceOpponentBatter,
  applyBatterHit,
  applySetCurrentBatter,
  applyMoveBaseRunner,
  type HitType
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
  runner_on_first_player_id: string | null;
  runner_on_second_player_id: string | null;
  runner_on_third_player_id: string | null;
};

type BaseKey = "first" | "second" | "third";
type MoveDestination = "second" | "third" | "home" | "out";
type MoveReason = "hit" | "error" | "steal" | "other" | "balk";

const MOVE_DESTINATIONS: Record<BaseKey, MoveDestination[]> = {
  first: ["second", "third", "home", "out"],
  second: ["third", "home", "out"],
  third: ["home", "out"]
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
  initialOpponentLineup,
  initialPositions
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
  initialPositions: Record<string, string | null>;
}) {
  const t = useTranslations();
  const { addToast } = useToast();
  const supabase = createClient();

  const [game, setGame] = useState<Game | null>(initialGame);
  const [opponentLineup, setOpponentLineup] = useState<OpponentBatter[]>(initialOpponentLineup);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncFailedCount, setSyncFailedCount] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);

  // Base-diamond interaction: clicking an empty base (our half) opens a
  // "place" picker; clicking an occupied base opens the "move this runner"
  // menu (destination, then reason). Opponent's half bypasses this
  // entirely -- see onBaseClick below. Tapping an empty FIRST base, on
  // either half, is intercepted ahead of all of that by the hit-by-pitch
  // prompt -- "no" falls through to whatever that tap would have done
  // otherwise.
  const [baseAction, setBaseAction] = useState<
    | { kind: "hbp-prompt"; base: "first" }
    | { kind: "place"; base: BaseKey }
    | { kind: "move-destination"; base: BaseKey }
    | { kind: "move-reason"; base: BaseKey; destination: MoveDestination }
    | null
  >(null);

  // Current-batter click: "choose" is the initial Replace/Resume-order
  // prompt; "replace" opens a bench picker (substitute_lineup_player);
  // "resume" opens a full-lineup picker (set_current_batter).
  const [batterPrompt, setBatterPrompt] = useState<"choose" | "replace" | "resume" | null>(null);

  // Pitcher click: always a straight substitution (no replace-vs-resume
  // choice like the batter has) -- a single-step full-roster picker.
  const [pitcherPrompt, setPitcherPrompt] = useState(false);

  // "+1 Strike" opens this instead of calling addCount directly -- a foul
  // ball only counts as a strike below 2, so it needs its own event type
  // rather than always mapping to "strike".
  const [strikePrompt, setStrikePrompt] = useState(false);

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
          p_occupied: action.occupied,
          p_player_id: action.playerId ?? null
        });
        if (rpcError) throw rpcError;
        return;
      }
      case "score_hit": {
        const { error: rpcError } = await supabase.rpc("record_batter_hit", {
          p_game_id: action.gameId,
          p_hit_type: action.hitType
        });
        if (rpcError) throw rpcError;
        return;
      }
      case "score_set_batter": {
        const { error: rpcError } = await supabase.rpc("set_current_batter", {
          p_game_id: action.gameId,
          p_player_id: action.playerId
        });
        if (rpcError) throw rpcError;
        return;
      }
      case "score_move_runner": {
        const { error: rpcError } = await supabase.rpc("move_base_runner", {
          p_game_id: action.gameId,
          p_from_base: action.fromBase,
          p_to_base: action.toBase,
          p_reason: action.reason
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
      addToast(t("toast.gameStarted"), "success");
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

  async function addCount(eventType: "ball" | "strike" | "out" | "foul") {
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
  async function removeCount(eventType: "ball" | "strike" | "out" | "foul") {
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

  async function setBaseRunner(base: "first" | "second" | "third", occupied: boolean, playerId: string | null = null) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_base", gameId: game.id, base, occupied, playerId };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyBaseRunner(game, base, occupied, playerId) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { error: baseError } = await supabase.rpc("set_base_runner", {
      p_game_id: game.id,
      p_base: base,
      p_occupied: occupied,
      p_player_id: playerId
    });
    setLoading(false);

    if (baseError) {
      if (looksOffline(baseError)) {
        setGame({ ...game, ...applyBaseRunner(game, base, occupied, playerId) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(baseError.message)));
    }
  }

  async function recordHit(hitType: HitType) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_hit", gameId: game.id, hitType };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyBatterHit(game, hitType, initialLineup, opponentBatterIds) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { data, error: hitError } = await supabase.rpc("record_batter_hit", {
      p_game_id: game.id,
      p_hit_type: hitType
    });
    setLoading(false);

    if (hitError) {
      if (looksOffline(hitError)) {
        setGame({ ...game, ...applyBatterHit(game, hitType, initialLineup, opponentBatterIds) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(hitError.message)));
      return;
    }
    if (data) setGame(data as Game);
  }

  async function setCurrentBatter(playerId: string) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_set_batter", gameId: game.id, playerId };

    if (!navigator.onLine) {
      setGame({ ...game, ...applySetCurrentBatter(game, playerId) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { error: batterError } = await supabase.rpc("set_current_batter", {
      p_game_id: game.id,
      p_player_id: playerId
    });
    setLoading(false);

    if (batterError) {
      if (looksOffline(batterError)) {
        setGame({ ...game, ...applySetCurrentBatter(game, playerId) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(batterError.message)));
    }
  }

  // Online-only, matching selectOurPitcher's existing behavior in
  // lineup-setup.tsx -- pitcher changes have never been queued offline.
  async function setPitcher(playerId: string) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: pitcherError } = await supabase.rpc("set_current_pitcher", {
      p_game_id: game.id,
      p_player_id: playerId
    });
    setLoading(false);
    if (pitcherError) {
      setError(t(rpcErrorKey(pitcherError.message)));
      return;
    }
    setGame({ ...game, current_pitcher_player_id: playerId });
  }

  // Substitution is online-only (matches lineup-setup.tsx's existing
  // no-offline behavior for lineup changes) -- no outbox queueing here.
  async function substituteLineupPlayer(outgoingId: string, incomingId: string) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: subError } = await supabase.rpc("substitute_lineup_player", {
      p_game_id: game.id,
      p_outgoing_player_id: outgoingId,
      p_incoming_player_id: incomingId
    });
    setLoading(false);
    if (subError) {
      setError(t(rpcErrorKey(subError.message)));
      return;
    }
    addToast(t("toast.playerSubstituted"), "success");
  }

  async function moveBaseRunner(fromBase: BaseKey, toBase: MoveDestination, reason: MoveReason) {
    if (!game) return;
    setLoading(true);
    setError(null);
    const offlineAction: OutboxAction = { kind: "score_move_runner", gameId: game.id, fromBase, toBase, reason };

    if (!navigator.onLine) {
      setGame({ ...game, ...applyMoveBaseRunner(game, fromBase, toBase) });
      await queueAction(offlineAction);
      setLoading(false);
      return;
    }

    const { data, error: moveError } = await supabase.rpc("move_base_runner", {
      p_game_id: game.id,
      p_from_base: fromBase,
      p_to_base: toBase,
      p_reason: reason
    });
    setLoading(false);

    if (moveError) {
      if (looksOffline(moveError)) {
        setGame({ ...game, ...applyMoveBaseRunner(game, fromBase, toBase) });
        await queueAction(offlineAction);
        return;
      }
      setError(t(rpcErrorKey(moveError.message)));
      return;
    }
    if (data) setGame(data as Game);
  }

  async function finalizeGame() {
    if (!game) return;
    setLoading(true);
    setError(null);
    const { error: finalizeError } = await supabase.rpc("finalize_game", { p_game_id: game.id });
    setLoading(false);
    if (finalizeError) {
      setError(t(rpcErrorKey(finalizeError.message)));
    } else {
      notifyGameFinalizedAction(teamId, eventId, locale).catch(() => {});
      addToast(t("toast.gameFinalized"), "success");
    }
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
            {loading ? t("common.starting") : t("game.startGame")}
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

  // Read-only field labels for the 8 non-pitcher spots -- the pitcher's
  // own marker stays driven by current_pitcher_player_id, not this map
  // (see plan: the live "who's actually pitching" pointer vs. the static
  // "who's assigned where" roster plan never drift against each other).
  const fielderPositions: Partial<Record<FielderPosition, string | null>> = {};
  for (const [playerId, position] of Object.entries(initialPositions)) {
    if (position && position !== "P") {
      fielderPositions[position as FielderPosition] = playerName(playerId);
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
              runnerOnFirstName={playerName(game.runner_on_first_player_id)}
              runnerOnSecondName={playerName(game.runner_on_second_player_id)}
              runnerOnThirdName={playerName(game.runner_on_third_player_id)}
              onBaseClick={
                isApprovedAdmin
                  ? (base, occupied) => {
                      if (base === "first" && !occupied) {
                        setBaseAction({ kind: "hbp-prompt", base: "first" });
                        return;
                      }
                      if (!isOurHalf) {
                        setBaseRunner(base, !occupied);
                        return;
                      }
                      setBaseAction(occupied ? { kind: "move-destination", base } : { kind: "place", base });
                    }
                  : undefined
              }
              battingName={battingDisplay}
              pitchingName={pitchingDisplay}
              onBattingNameClick={
                isApprovedAdmin && isOurHalf && game.current_batter_player_id !== null
                  ? () => setBatterPrompt("choose")
                  : undefined
              }
              onPitchingNameClick={isApprovedAdmin && !isOurHalf ? () => setPitcherPrompt(true) : undefined}
              fielderPositions={fielderPositions}
              cornerContent={
                <div className="flex flex-col gap-0.5 text-[10px] font-medium text-slate-700">
                  <span className="flex items-center gap-1">
                    {t("game.outs")}:
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className={`h-2 w-2 rounded-full ${i < game.outs ? "bg-slate-900" : "bg-slate-300"}`}
                      />
                    ))}
                  </span>
                  <span>
                    {t("game.count")}: {game.balls}-{game.strikes}
                  </span>
                  {pitchCount !== null && (
                    <span>
                      {t("game.pitchCountAbbrev")}: {String(pitchCount).padStart(2, "0")}
                    </span>
                  )}
                </div>
              }
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
      </div>

      {isLive && isApprovedAdmin && baseAction && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-300 p-3">
          {baseAction.kind === "hbp-prompt" && (
            <>
              <p className="text-xs font-medium text-slate-500">{t("game.hbpPrompt.title")}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    recordHit("hbp");
                    setBaseAction(null);
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                >
                  {t("game.hbpPrompt.yes")}
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    if (isOurHalf) {
                      setBaseAction({ kind: "place", base: "first" });
                    } else {
                      setBaseRunner("first", true);
                      setBaseAction(null);
                    }
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                >
                  {t("game.hbpPrompt.no")}
                </button>
              </div>
            </>
          )}

          {baseAction.kind === "place" && (
            <>
              <p className="text-xs font-medium text-slate-500">{t("game.moveRunner.placeTitle")}</p>
              <div className="flex flex-wrap gap-2">
                {initialLineup.map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      setBaseRunner(baseAction.base, true, id);
                      setBaseAction(null);
                    }}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                  >
                    {playerName(id)}
                  </button>
                ))}
              </div>
            </>
          )}

          {baseAction.kind === "move-destination" && (
            <>
              <p className="text-xs font-medium text-slate-500">{t("game.moveRunner.title")}</p>
              <div className="flex flex-wrap gap-2">
                {MOVE_DESTINATIONS[baseAction.base].map((destination) => (
                  <button
                    key={destination}
                    type="button"
                    disabled={loading}
                    onClick={() => setBaseAction({ kind: "move-reason", base: baseAction.base, destination })}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                  >
                    {t(`game.moveRunner.destination.${destination}`)}
                  </button>
                ))}
              </div>
            </>
          )}

          {baseAction.kind === "move-reason" && (
            <>
              <p className="text-xs font-medium text-slate-500">{t("game.moveRunner.reasonTitle")}</p>
              <div className="flex flex-wrap gap-2">
                {(["hit", "error", "steal", "other", "balk"] as const).map((reason) => (
                  <button
                    key={reason}
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      moveBaseRunner(baseAction.base, baseAction.destination, reason);
                      setBaseAction(null);
                    }}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                  >
                    {t(`game.moveRunner.reason.${reason}`)}
                  </button>
                ))}
              </div>
            </>
          )}

          <button
            type="button"
            onClick={() => setBaseAction(null)}
            className="self-start text-xs font-medium text-slate-500 underline"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {isLive && isApprovedAdmin && batterPrompt && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-300 p-3">
          {batterPrompt === "choose" && (
            <>
              <p className="text-xs font-medium text-slate-500">{t("game.currentBatterPrompt.title")}</p>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setBatterPrompt("replace")}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
                >
                  {t("game.currentBatterPrompt.replace")}
                </button>
                <button
                  type="button"
                  onClick={() => setBatterPrompt("resume")}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
                >
                  {t("game.currentBatterPrompt.resumeOrder")}
                </button>
              </div>
            </>
          )}

          {batterPrompt === "replace" && (
            <>
              <p className="text-xs font-medium text-slate-500">{t("game.selectReplacement")}</p>
              <div className="flex flex-wrap gap-2">
                {roster
                  .filter((p) => !initialLineup.includes(p.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={loading}
                      onClick={() => {
                        if (game.current_batter_player_id) {
                          substituteLineupPlayer(game.current_batter_player_id, p.id);
                        }
                        setBatterPrompt(null);
                      }}
                      className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                    >
                      {playerName(p.id)}
                    </button>
                  ))}
              </div>
            </>
          )}

          {batterPrompt === "resume" && (
            <>
              <p className="text-xs font-medium text-slate-500">{t("game.selectResumeBatter")}</p>
              <div className="flex flex-wrap gap-2">
                {initialLineup.map((id) => (
                  <button
                    key={id}
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      setCurrentBatter(id);
                      setBatterPrompt(null);
                    }}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
                  >
                    {playerName(id)}
                  </button>
                ))}
              </div>
            </>
          )}

          <button
            type="button"
            onClick={() => setBatterPrompt(null)}
            className="self-start text-xs font-medium text-slate-500 underline"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {isLive && isApprovedAdmin && pitcherPrompt && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-300 p-3">
          <p className="text-xs font-medium text-slate-500">{t("game.pitcherPrompt.title")}</p>
          <div className="flex flex-wrap gap-2">
            {roster.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={loading}
                onClick={() => {
                  setPitcher(p.id);
                  setPitcherPrompt(false);
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
              >
                {playerName(p.id)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setPitcherPrompt(false)}
            className="self-start text-xs font-medium text-slate-500 underline"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {isLive && isApprovedAdmin && strikePrompt && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-300 p-3">
          <p className="text-xs font-medium text-slate-500">{t("game.strikePrompt.title")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                addCount("strike");
                setStrikePrompt(false);
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
            >
              {t("game.strikePrompt.swingAndMiss")}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={() => {
                addCount("foul");
                setStrikePrompt(false);
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
            >
              {t("game.strikePrompt.foulBall")}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setStrikePrompt(false)}
            className="self-start text-xs font-medium text-slate-500 underline"
          >
            {t("common.cancel")}
          </button>
        </div>
      )}

      {isLive && isApprovedAdmin && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            {(["single", "double", "triple", "home_run"] as const).map((hitType) => (
              <button
                key={hitType}
                type="button"
                disabled={loading}
                onClick={() => recordHit(hitType)}
                className="flex-1 rounded-lg border border-slate-300 px-2 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
              >
                {t(`game.hit.${hitType}`)}
              </button>
            ))}
          </div>

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
                  onClick={() => (type === "strike" ? setStrikePrompt(true) : addCount(type))}
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
            {loading ? t("common.finalizing") : t("game.finalizeGame")}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
