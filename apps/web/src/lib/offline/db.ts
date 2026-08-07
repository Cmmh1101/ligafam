import Dexie, { type EntityTable } from "dexie";

/**
 * Local cache + outbox for offline-first reads/writes.
 *
 * Reads (roster, calendar, cached scores) are cached here on every
 * successful fetch so the UI can render something meaningful offline.
 *
 * Writes made offline (RSVP change, chat message, snack claim) are queued
 * in `outbox` and flushed in order when connectivity returns. Live scoring
 * intentionally does NOT go through this outbox — see architecture-plan.md
 * §5.4 for why.
 */

export type OutboxAction =
  | { kind: "rsvp_update"; eventId: string; playerId: string; status: string }
  | { kind: "chat_message"; teamId: string; body: string; clientId: string }
  | { kind: "snack_claim"; eventId: string; familyLinkId: string; item: string };

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

export { db };
