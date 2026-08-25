"use client";

import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";
import { useToast } from "@/components/toast/toast-context";

type RosterPlayer = {
  id: string;
  first_name: string;
  last_name: string;
  jersey_number: string | null;
  primary_position: string | null;
};

const POSITION_CODES = ["P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"] as const;

type InitialGame = {
  id: string;
  current_pitcher_player_id: string | null;
  opponent_pitcher_name: string | null;
  opponent_pitcher_number: string | null;
};

type OpponentEntry = {
  key: string;
  display_name: string;
  jersey_number: string;
};

let entryKeyCounter = 0;
function nextEntryKey() {
  entryKeyCounter += 1;
  return `opp-${entryKeyCounter}`;
}

// Shared pointer-based drag-to-reorder for a small list, used for both our
// batting order and the opponent's. HTML5 Drag and Drop doesn't fire
// reliably on touchscreens without a polyfill, so this hand-rolls reorder
// with the Pointer Events API instead, which unifies mouse/touch/pen.
function useDragReorder<T>(items: T[], setItems: (next: T[]) => void) {
  // draggingIndexRef/itemsRef hold the values onPointerMove actually reads
  // -- refs update synchronously, unlike useState, which can still be
  // showing the previous render's value if a pointermove fires before
  // React has flushed the pointerdown's state update (React batches state
  // updates, so two events dispatched back-to-back with no yield between
  // them can both run against the same stale closure). The `useState`
  // twin of draggingIndex is kept only to trigger a re-render for styling
  // the currently-dragged row.
  const draggingIndexRef = useRef<number | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const [draggingIndex, setDraggingIndexState] = useState<number | null>(null);
  const [offsetY, setOffsetY] = useState(0);
  const startYRef = useRef(0);
  const rowHeightRef = useRef(44);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);

  function setDraggingIndex(index: number | null) {
    draggingIndexRef.current = index;
    setDraggingIndexState(index);
  }

  function setRowRef(index: number, el: HTMLLIElement | null) {
    rowRefs.current[index] = el;
  }

  function onPointerDown(index: number, e: ReactPointerEvent<HTMLElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingIndex(index);
    startYRef.current = e.clientY;
    const el = rowRefs.current[index];
    rowHeightRef.current = el ? el.getBoundingClientRect().height : 44;
    setOffsetY(0);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const idx = draggingIndexRef.current;
    if (idx === null) return;
    const delta = e.clientY - startYRef.current;
    setOffsetY(delta);

    // A dead-zone past the geometric midpoint, not an exact-midpoint
    // trigger -- touch contact is imprecise compared to a mouse pointer,
    // an exact-midpoint swap tends to flicker/jitter on touch.
    const threshold = rowHeightRef.current * 0.6;
    const currentItems = itemsRef.current;
    if (delta > threshold && idx < currentItems.length - 1) {
      const next = [...currentItems];
      const target = idx + 1;
      [next[idx], next[target]] = [next[target], next[idx]];
      setItems(next);
      setDraggingIndex(target);
      startYRef.current = e.clientY;
      setOffsetY(0);
    } else if (delta < -threshold && idx > 0) {
      const next = [...currentItems];
      const target = idx - 1;
      [next[idx], next[target]] = [next[target], next[idx]];
      setItems(next);
      setDraggingIndex(target);
      startYRef.current = e.clientY;
      setOffsetY(0);
    }
  }

  function endDrag() {
    setDraggingIndex(null);
    setOffsetY(0);
  }

  return {
    draggingIndex,
    offsetY,
    setRowRef,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    // iOS fires pointercancel (not pointerup) for interruptions -- an
    // incoming call, a notification pull-down, the edge-swipe-back gesture
    // -- handled identically to a clean release so drag state never gets
    // stuck mid-gesture.
    onPointerCancel: endDrag
  };
}

export function LineupSetup({
  eventId,
  initialGame,
  roster,
  initialLineup,
  initialOpponentLineup,
  initialPositions
}: {
  eventId: string;
  initialGame: InitialGame | null;
  roster: RosterPlayer[];
  initialLineup: string[];
  initialOpponentLineup: { display_name: string | null; jersey_number: string | null }[];
  initialPositions: Record<string, string | null>;
}) {
  const t = useTranslations();
  const supabase = createClient();
  const { addToast } = useToast();

  // The server-rendered `initialGame` reflects page-load time -- if the
  // admin starts the game (on the Marcador tab) in the same session
  // without reloading, that server-rendered prop stays stale forever
  // (Server Components don't re-render on client-side state changes).
  // A small Realtime subscription, same event_id-filtered pattern as
  // GameScorePanel, picks up the game's id as soon as start_game creates
  // it, without needing a page reload.
  const [gameId, setGameId] = useState<string | null>(initialGame?.id ?? null);

  useEffect(() => {
    if (gameId) return;
    const channel = supabase
      .channel(`lineup-setup-${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "games", filter: `event_id=eq.${eventId}` },
        (payload) => setGameId((payload.new as { id: string }).id)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, gameId]);

  const [ourLineup, setOurLineup] = useState<string[]>(initialLineup);
  const [positions, setPositions] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const player of roster) {
      map[player.id] = initialPositions[player.id] ?? player.primary_position ?? "";
    }
    return map;
  });
  const [ourPitcherId, setOurPitcherId] = useState(initialGame?.current_pitcher_player_id ?? "");
  const [opponentEntries, setOpponentEntries] = useState<OpponentEntry[]>(
    initialOpponentLineup.map((entry) => ({
      key: nextEntryKey(),
      display_name: entry.display_name ?? "",
      jersey_number: entry.jersey_number ?? ""
    }))
  );
  const [opponentPitcherName, setOpponentPitcherName] = useState(initialGame?.opponent_pitcher_name ?? "");
  const [opponentPitcherNumber, setOpponentPitcherNumber] = useState(initialGame?.opponent_pitcher_number ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [substitutingId, setSubstitutingId] = useState<string | null>(null);

  const ourDrag = useDragReorder(ourLineup, setOurLineup);
  const opponentDrag = useDragReorder(opponentEntries, setOpponentEntries);

  if (!gameId) {
    return <p className="text-slate-600">{t("game.notStartedYet")}</p>;
  }

  // TS doesn't narrow `gameId` through the async function closures below --
  // a fresh non-null binding avoids repeating a non-null assertion at every
  // RPC call site.
  const confirmedGameId: string = gameId;

  function addToOurLineup(playerId: string) {
    setOurLineup((prev) => [...prev, playerId]);
  }

  function removeFromOurLineup(playerId: string) {
    setOurLineup((prev) => prev.filter((id) => id !== playerId));
  }

  async function saveOurLineup() {
    if (ourLineup.length === 0) return;
    setLoading(true);
    setError(null);
    const { error: lineupError } = await supabase.rpc("set_lineup", {
      p_game_id: confirmedGameId,
      p_player_ids: ourLineup
    });
    setLoading(false);
    if (lineupError) {
      setError(t(rpcErrorKey(lineupError.message)));
    } else {
      addToast(t("toast.lineupSaved"), "success");
    }
  }

  // Immediate write (bypasses "Guardar alineación"/set_lineup entirely) --
  // preserves batting_order and current_batter_player_id, unlike a full
  // lineup save. No offline queueing, matching this component's existing
  // no-offline behavior for lineup changes.
  async function substitutePlayer(outgoingId: string, incomingId: string) {
    setLoading(true);
    setError(null);
    const { error: subError } = await supabase.rpc("substitute_lineup_player", {
      p_game_id: confirmedGameId,
      p_outgoing_player_id: outgoingId,
      p_incoming_player_id: incomingId
    });
    setLoading(false);
    if (subError) {
      setError(t(rpcErrorKey(subError.message)));
      return;
    }
    setOurLineup((prev) => prev.map((id) => (id === outgoingId ? incomingId : id)));
    addToast(t("toast.playerSubstituted"), "success");
  }

  async function selectOurPitcher(playerId: string) {
    setOurPitcherId(playerId);
    setLoading(true);
    setError(null);
    const { error: pitcherError } = await supabase.rpc("set_current_pitcher", {
      p_game_id: confirmedGameId,
      p_player_id: playerId || null
    });
    setLoading(false);
    if (pitcherError) setError(t(rpcErrorKey(pitcherError.message)));
  }

  // Same immediate-write shape as selectOurPitcher. Only works for a
  // player already saved into game_lineup -- a freshly-added-but-unsaved
  // lineup slot surfaces PLAYER_NOT_IN_LINEUP via the existing error
  // path, same as any other RPC failure here.
  async function setLineupPosition(playerId: string, position: string) {
    setPositions((prev) => ({ ...prev, [playerId]: position }));
    setLoading(true);
    setError(null);
    const { error: positionError } = await supabase.rpc("set_lineup_position", {
      p_game_id: confirmedGameId,
      p_player_id: playerId,
      p_position: position || null
    });
    setLoading(false);
    if (positionError) setError(t(rpcErrorKey(positionError.message)));
  }

  function addOpponentEntry() {
    setOpponentEntries((prev) => [...prev, { key: nextEntryKey(), display_name: "", jersey_number: "" }]);
  }

  function removeOpponentEntry(key: string) {
    setOpponentEntries((prev) => prev.filter((entry) => entry.key !== key));
  }

  function updateOpponentEntry(key: string, field: "display_name" | "jersey_number", value: string) {
    setOpponentEntries((prev) => prev.map((entry) => (entry.key === key ? { ...entry, [field]: value } : entry)));
  }

  async function saveOpponentLineup() {
    if (opponentEntries.length === 0) return;
    setLoading(true);
    setError(null);
    const { error: lineupError } = await supabase.rpc("set_opponent_lineup", {
      p_game_id: confirmedGameId,
      p_entries: opponentEntries.map((entry) => ({
        display_name: entry.display_name,
        jersey_number: entry.jersey_number
      }))
    });
    setLoading(false);
    if (lineupError) {
      setError(t(rpcErrorKey(lineupError.message)));
    } else {
      addToast(t("toast.opponentLineupSaved"), "success");
    }
  }

  async function saveOpponentPitcher() {
    setLoading(true);
    setError(null);
    const { error: pitcherError } = await supabase.rpc("set_opponent_pitcher", {
      p_game_id: confirmedGameId,
      p_name: opponentPitcherName,
      p_number: opponentPitcherNumber
    });
    setLoading(false);
    if (pitcherError) setError(t(rpcErrorKey(pitcherError.message)));
  }

  const availablePlayers = roster.filter((p) => !ourLineup.includes(p.id));
  const orderedOurLineup = ourLineup.flatMap((id) => {
    const player = roster.find((p) => p.id === id);
    return player ? [player] : [];
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-slate-500">{t("game.pitcherLabel")}</label>
        <select
          value={ourPitcherId}
          disabled={loading}
          onChange={(e) => selectOurPitcher(e.target.value)}
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

        {orderedOurLineup.length > 0 && (
          <ul className="flex flex-col gap-1">
            {orderedOurLineup.map((player, index) => (
              <li
                key={player.id}
                ref={(el) => ourDrag.setRowRef(index, el)}
                style={{
                  transform: ourDrag.draggingIndex === index ? `translateY(${ourDrag.offsetY}px)` : undefined,
                  userSelect: "none",
                  WebkitUserSelect: "none"
                }}
                className={`flex flex-col gap-1 rounded-lg border border-slate-300 bg-white px-2 py-2 ${
                  ourDrag.draggingIndex === index ? "relative z-10 shadow-md" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    onPointerDown={(e) => ourDrag.onPointerDown(index, e)}
                    onPointerMove={ourDrag.onPointerMove}
                    onPointerUp={ourDrag.onPointerUp}
                    onPointerCancel={ourDrag.onPointerCancel}
                    style={{ touchAction: "none" }}
                    className="flex h-8 w-8 cursor-grab items-center justify-center text-slate-400"
                  >
                    ⠿
                  </span>
                  <span className="w-5 text-sm font-medium text-slate-500">{index + 1}</span>
                  <span className="flex-1 text-sm text-slate-900">
                    {player.first_name} {player.last_name}
                    {player.jersey_number ? ` #${player.jersey_number}` : ""}
                  </span>
                  <select
                    value={positions[player.id] ?? ""}
                    disabled={loading}
                    onChange={(e) => setLineupPosition(player.id, e.target.value)}
                    className="rounded-lg border border-slate-300 px-1.5 py-1 text-xs"
                  >
                    <option value="">—</option>
                    {POSITION_CODES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => setSubstitutingId(substitutingId === player.id ? null : player.id)}
                    aria-label={t("game.substitutePlayer")}
                    title={t("game.substitutePlayer")}
                    className="text-sm font-medium text-slate-400 hover:text-slate-600"
                  >
                    ⇄
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => removeFromOurLineup(player.id)}
                    aria-label={t("common.delete")}
                    className="text-xs font-medium text-slate-400 hover:text-slate-600"
                  >
                    ✕
                  </button>
                </div>

                {substitutingId === player.id && (
                  <div className="flex flex-wrap gap-2 pl-7">
                    {availablePlayers.length === 0 && (
                      <span className="text-xs text-slate-500">{t("game.noReserveAvailable")}</span>
                    )}
                    {availablePlayers.map((bench) => (
                      <button
                        key={bench.id}
                        type="button"
                        disabled={loading}
                        onClick={() => {
                          substitutePlayer(player.id, bench.id);
                          setSubstitutingId(null);
                        }}
                        className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
                      >
                        {bench.first_name} {bench.last_name}
                        {bench.jersey_number ? ` #${bench.jersey_number}` : ""}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {availablePlayers.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {availablePlayers.map((player) => (
              <button
                key={player.id}
                type="button"
                disabled={loading}
                onClick={() => addToOurLineup(player.id)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 disabled:opacity-50"
              >
                + {player.first_name} {player.last_name}
                {player.jersey_number ? ` #${player.jersey_number}` : ""}
              </button>
            ))}
          </div>
        )}

        <button
          type="button"
          disabled={loading || ourLineup.length === 0}
          onClick={saveOurLineup}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? t("common.saving") : t("game.saveLineup")}
        </button>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
        <p className="text-xs font-medium text-slate-500">{t("game.opponentPitcherLabel")}</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={opponentPitcherName}
            onChange={(e) => setOpponentPitcherName(e.target.value)}
            onBlur={saveOpponentPitcher}
            placeholder={t("game.opponentPitcherName")}
            className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="text"
            value={opponentPitcherNumber}
            onChange={(e) => setOpponentPitcherNumber(e.target.value)}
            onBlur={saveOpponentPitcher}
            placeholder={t("game.opponentPitcherNumber")}
            className="w-20 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-3">
        <p className="text-xs font-medium text-slate-500">{t("game.opponentLineupTitle")}</p>

        {opponentEntries.length > 0 && (
          <ul className="flex flex-col gap-1">
            {opponentEntries.map((entry, index) => (
              <li
                key={entry.key}
                ref={(el) => opponentDrag.setRowRef(index, el)}
                style={{
                  transform:
                    opponentDrag.draggingIndex === index ? `translateY(${opponentDrag.offsetY}px)` : undefined
                }}
                className={`flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-2 py-2 ${
                  opponentDrag.draggingIndex === index ? "relative z-10 shadow-md" : ""
                }`}
              >
                <span
                  onPointerDown={(e) => opponentDrag.onPointerDown(index, e)}
                  onPointerMove={opponentDrag.onPointerMove}
                  onPointerUp={opponentDrag.onPointerUp}
                  onPointerCancel={opponentDrag.onPointerCancel}
                  style={{ touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
                  className="flex h-8 w-8 cursor-grab items-center justify-center text-slate-400"
                >
                  ⠿
                </span>
                <span className="w-5 text-sm font-medium text-slate-500">{index + 1}</span>
                <input
                  type="text"
                  value={entry.display_name}
                  onChange={(e) => updateOpponentEntry(entry.key, "display_name", e.target.value)}
                  placeholder={t("game.opponentPitcherName")}
                  className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                />
                <input
                  type="text"
                  value={entry.jersey_number}
                  onChange={(e) => updateOpponentEntry(entry.key, "jersey_number", e.target.value)}
                  placeholder="#"
                  className="w-14 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => removeOpponentEntry(entry.key)}
                  aria-label={t("common.delete")}
                  className="text-xs font-medium text-slate-400 hover:text-slate-600"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <button
          type="button"
          disabled={loading}
          onClick={addOpponentEntry}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 disabled:opacity-50"
        >
          {t("game.addOpponentBatter")}
        </button>

        <button
          type="button"
          disabled={loading || opponentEntries.length === 0}
          onClick={saveOpponentLineup}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading ? t("common.saving") : t("game.saveOpponentLineup")}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
