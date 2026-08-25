import Dexie, { type EntityTable } from "dexie";

/**
 * Local cache + outbox for offline-first reads/writes.
 *
 * Reads (roster, calendar, cached scores) are cached here on every
 * successful fetch so the UI can render something meaningful offline.
 *
 * Writes made offline are queued in `outbox` and flushed in order when
 * connectivity returns. As of this writing, live scoring (game-score-panel.tsx)
 * is the only real consumer of this outbox -- the rsvp_update/chat_message/
 * snack_claim action kinds below are scaffolding for future features, not
 * yet wired to any actual write path.
 */

export type OutboxAction =
  | { kind: "rsvp_update"; eventId: string; playerId: string; status: string }
  | { kind: "chat_message"; teamId: string; body: string; clientId: string }
  | { kind: "snack_claim"; eventId: string; familyLinkId: string; item: string }
  | { kind: "score_count"; gameId: string; eventType: "ball" | "strike" | "out"; delta: 1 | -1 }
  | { kind: "score_run"; gameId: string; scoringTeam: "us" | "opponent"; runs: 1 | -1 }
  | {
      kind: "score_base";
      gameId: string;
      base: "first" | "second" | "third";
      occupied: boolean;
      playerId?: string | null;
    }
  | { kind: "score_home_or_away"; gameId: string; value: "home" | "away" }
  | { kind: "score_advance_batter"; gameId: string }
  | { kind: "score_advance_opponent_batter"; gameId: string }
  | { kind: "score_hit"; gameId: string; hitType: "single" | "double" | "triple" | "home_run" | "hbp" }
  | { kind: "score_set_batter"; gameId: string; playerId: string }
  | {
      kind: "score_move_runner";
      gameId: string;
      fromBase: "first" | "second" | "third";
      toBase: "second" | "third" | "home" | "out";
      reason: "hit" | "error" | "steal" | "other" | "balk";
    };

interface OutboxRow {
  id?: number;
  createdAt: number;
  action: OutboxAction;
  syncedAt?: number;
  error?: string;
}

interface CachedTeamRow {
  teamId: string;
  json: string; // serialized team + roster + calendar snapshot
  cachedAt: number;
}

const db = new Dexie("ligafam") as Dexie & {
  outbox: EntityTable<OutboxRow, "id">;
  cachedTeams: EntityTable<CachedTeamRow, "teamId">;
};

db.version(1).stores({
  outbox: "++id, createdAt, syncedAt",
  cachedTeams: "teamId, cachedAt"
});

export async function queueAction(action: OutboxAction) {
  await db.outbox.add({ action, createdAt: Date.now() });
}

export async function flushOutbox(
  handler: (action: OutboxAction) => Promise<void>
) {
  const pending = await db.outbox.filter((row) => !row.syncedAt).toArray();

  for (const row of pending) {
    try {
      await handler(row.action);
      await db.outbox.update(row.id!, { syncedAt: Date.now() });
    } catch (err) {
      // Leave it queued and retry on the next reconnect/app-open.
      await db.outbox.update(row.id!, { error: String(err) });
    }
  }
}

// Scoring-specific flush: unlike flushOutbox above, this stops at the first
// permanent (fatal) rejection instead of continuing past it. Scoring actions
// are sequential and order-dependent (each RPC reads current state and
// applies a relative delta), so once one is permanently rejected -- e.g.
// GAME_ALREADY_FINAL because someone else finalized the game while this
// device was offline -- every action still queued behind it is replaying
// against a game that will reject it identically. Silently retrying forever
// on every future reconnect (flushOutbox's behavior, which is fine for
// independent actions like RSVP/chat/snack) would just spin without ever
// resolving here, so this marks the whole remaining batch as failed instead.
export async function flushScoreOutbox(
  gameId: string,
  handler: (action: OutboxAction) => Promise<void>,
  isFatalError: (err: unknown) => boolean
): Promise<{ ok: true } | { ok: false; reason: "network" | "fatal"; error?: unknown }> {
  const pending = await db.outbox
    .filter((row) => !row.syncedAt && "gameId" in row.action && row.action.gameId === gameId)
    .toArray();

  for (const row of pending) {
    try {
      await handler(row.action);
      await db.outbox.update(row.id!, { syncedAt: Date.now() });
    } catch (err) {
      if (isFatalError(err)) {
        const remaining = pending.slice(pending.indexOf(row));
        await Promise.all(
          remaining.map((r) => db.outbox.update(r.id!, { syncedAt: Date.now(), error: String(err) }))
        );
        return { ok: false, reason: "fatal", error: err };
      }
      // Looks like another network blip mid-flush -- stop here, leave this
      // row onward queued, retry the whole batch on the next reconnect.
      return { ok: false, reason: "network", error: err };
    }
  }
  return { ok: true };
}

export async function pendingScoreCount(gameId: string): Promise<number> {
  return db.outbox.filter((row) => !row.syncedAt && "gameId" in row.action && row.action.gameId === gameId).count();
}

export { db };
