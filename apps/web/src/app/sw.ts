import { defaultCache } from "@serwist/next/worker";
import { Serwist } from "serwist";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Reads (roster, calendar, scores) fall back to cache when offline.
  // Writes (RSVP, chat, snack sign-up) are handled by the app-level
  // Dexie outbox in src/lib/offline/outbox.ts — the SW does not intercept
  // Supabase POST/PATCH requests, since those need conflict-aware sync logic
  // rather than blind cache-then-network.
  runtimeCaching: defaultCache
});

serwist.addEventListeners();
