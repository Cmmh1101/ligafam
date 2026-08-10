"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type RsvpStatus = "yes" | "no" | "maybe" | "no_response";

const OPTIONS: Exclude<RsvpStatus, "no_response">[] = ["yes", "no", "maybe"];

export function RsvpToggle({
  eventId,
  playerId,
  currentStatus,
  userId
}: {
  eventId: string;
  playerId: string;
  currentStatus: RsvpStatus;
  userId: string;
}) {
  const t = useTranslations("rsvp");
  const router = useRouter();
  const supabase = createClient();
  const [loading, setLoading] = useState(false);

  async function setStatus(status: RsvpStatus) {
    setLoading(true);
    // Upsert, not update -- a player added to the roster after the event
    // was created has no pre-seeded event_rsvps row, and a plain .update()
    // would silently no-op for them.
    await supabase.from("event_rsvps").upsert(
      { event_id: eventId, player_id: playerId, status, responded_by: userId },
      { onConflict: "event_id,player_id" }
    );
    setLoading(false);
    router.refresh();
  }

  return (
    <div className="flex gap-2">
      {OPTIONS.map((status) => (
        <button
          key={status}
          type="button"
          disabled={loading}
          onClick={() => setStatus(status)}
          className={`rounded-full border px-3 py-1 text-sm font-medium disabled:opacity-50 ${
            currentStatus === status
              ? "border-slate-900 bg-slate-900 text-white"
              : "border-slate-300 text-slate-700 hover:bg-slate-50"
          }`}
        >
          {t(status)}
        </button>
      ))}
    </div>
  );
}
