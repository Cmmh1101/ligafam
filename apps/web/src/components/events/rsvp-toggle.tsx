"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type RsvpStatus = "yes" | "no" | "maybe" | "no_response";
type RsvpOption = Exclude<RsvpStatus, "no_response">;

const OPTIONS: RsvpOption[] = ["yes", "no", "maybe"];

const SELECTED_CLASSES: Record<RsvpOption, string> = {
  yes: "border-emerald-600 bg-emerald-600 text-white",
  no: "border-red-600 bg-red-600 text-white",
  maybe: "border-amber-500 bg-amber-500 text-white"
};

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d="M4 10.5l4 4 8-9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function QuestionIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
      <path
        d="M7.5 7.5a2.5 2.5 0 114.359 1.687c-.545.545-1.359.938-1.359 1.813v.5M10 14.5h.01"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const ICONS: Record<RsvpOption, () => React.JSX.Element> = {
  yes: CheckIcon,
  no: XIcon,
  maybe: QuestionIcon
};

// Read-only equivalent of the toggle above, for viewers who aren't the
// player's linked family member (e.g. an admin looking at the roster).
export function RsvpStatusBadge({ status }: { status: RsvpStatus }) {
  const t = useTranslations("rsvp");

  if (status === "no_response") {
    return <span className="text-sm text-slate-500">{t("no_response")}</span>;
  }

  const Icon = ICONS[status];
  return (
    <span
      title={t(status)}
      aria-label={t(status)}
      className={`flex h-8 w-8 items-center justify-center rounded-full border ${SELECTED_CLASSES[status]}`}
    >
      <Icon />
    </span>
  );
}

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
      {OPTIONS.map((status) => {
        const Icon = ICONS[status];
        return (
          <button
            key={status}
            type="button"
            disabled={loading}
            onClick={() => setStatus(status)}
            aria-label={t(status)}
            title={t(status)}
            className={`flex h-8 w-8 items-center justify-center rounded-full border disabled:opacity-50 ${
              currentStatus === status
                ? SELECTED_CLASSES[status]
                : "border-slate-300 text-slate-500 hover:bg-slate-50"
            }`}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}
