"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

type Tab = "board" | "roster" | "attendance" | "stats" | "snacks";

// Small inline stroke-based icons, ~24px grid -- this app has no icon
// library, so these set the style for whatever comes next. Each tab button
// keeps the real text label as aria-label/title; these only replace the
// *visible* label so five tabs fit without crowding.
function ScoreboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="9" y1="10" x2="9" y2="19" />
      <line x1="15" y1="10" x2="15" y2="19" />
    </svg>
  );
}

function DiamondIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
      <path d="M12 3 L21 12 L12 21 L3 12 Z" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function StatsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
      <line x1="5" y1="20" x2="5" y2="12" />
      <line x1="12" y1="20" x2="12" y2="7" />
      <line x1="19" y1="20" x2="19" y2="15" />
    </svg>
  );
}

function AttendanceIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
      <circle cx="9" cy="8" r="2.5" />
      <path d="M4 19c0-2.8 2.2-5 5-5s5 2.2 5 5" />
      <circle cx="17" cy="9" r="2" />
      <path d="M14.5 14.2c.5-.15 1-.2 1.5-.2 2.5 0 4.5 2 4.5 4.5" />
    </svg>
  );
}

function SnacksIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
      <path d="M7 4h10l-1 13a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2L7 4Z" />
      <line x1="6" y1="4" x2="18" y2="4" />
      <line x1="10" y1="8" x2="10" y2="15" />
      <line x1="14" y1="8" x2="14" y2="15" />
    </svg>
  );
}

export function EventTabs({
  boardContent,
  rosterContent,
  attendanceContent,
  statsContent,
  snacksContent
}: {
  boardContent: ReactNode;
  rosterContent: ReactNode;
  attendanceContent: ReactNode | null;
  statsContent: ReactNode;
  snacksContent: ReactNode | null;
}) {
  const t = useTranslations();
  const [tab, setTab] = useState<Tab>("board");

  const tabs: { key: Tab; label: string; icon: ReactNode }[] = [
    { key: "board", label: t("game.boardTab"), icon: <ScoreboardIcon /> },
    { key: "roster", label: t("game.rosterTab"), icon: <DiamondIcon /> },
    ...(attendanceContent !== null
      ? [{ key: "attendance" as Tab, label: t("game.attendanceTab"), icon: <AttendanceIcon /> }]
      : []),
    { key: "stats", label: t("game.statsTab"), icon: <StatsIcon /> },
    ...(snacksContent !== null ? [{ key: "snacks" as Tab, label: t("game.snacksTab"), icon: <SnacksIcon /> }] : [])
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex border-b border-slate-200">
        {tabs.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-label={label}
            title={label}
            className={`flex flex-1 items-center justify-center border-b-2 py-2.5 ${
              tab === key ? "border-slate-900 text-slate-900" : "border-transparent text-slate-400"
            }`}
          >
            {icon}
          </button>
        ))}
      </div>

      {/* Panels stay mounted -- toggled via CSS, not conditional rendering
          -- so GameScorePanel's Realtime subscription (inside boardContent)
          doesn't drop and re-establish every time the admin switches tabs.
          Attendance and snacks are the exception: each is omitted entirely
          (not just hidden) when its content is null, for viewers who
          shouldn't see it. */}
      <div className={tab === "board" ? "flex flex-col gap-6" : "hidden"}>{boardContent}</div>
      <div className={tab === "roster" ? "flex flex-col gap-6" : "hidden"}>{rosterContent}</div>
      {attendanceContent !== null && (
        <div className={tab === "attendance" ? "flex flex-col gap-6" : "hidden"}>{attendanceContent}</div>
      )}
      <div className={tab === "stats" ? "flex flex-col gap-6" : "hidden"}>{statsContent}</div>
      {snacksContent !== null && (
        <div className={tab === "snacks" ? "flex flex-col gap-6" : "hidden"}>{snacksContent}</div>
      )}
    </div>
  );
}
