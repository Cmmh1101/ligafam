"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

type Tab = "board" | "roster" | "snacks";

export function EventTabs({
  boardContent,
  rosterContent,
  snacksContent
}: {
  boardContent: ReactNode;
  rosterContent: ReactNode;
  snacksContent: ReactNode;
}) {
  const t = useTranslations();
  const [tab, setTab] = useState<Tab>("board");

  const tabs: { key: Tab; label: string }[] = [
    { key: "board", label: t("game.boardTab") },
    { key: "roster", label: t("game.rosterTab") },
    { key: "snacks", label: t("game.snacksTab") }
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex border-b border-slate-200">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 border-b-2 py-2 text-center text-sm font-medium ${
              tab === key ? "border-slate-900 text-slate-900" : "border-transparent text-slate-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* All three panels stay mounted -- toggled via CSS, not conditional
          rendering -- so GameScorePanel's Realtime subscription (inside
          boardContent) doesn't drop and re-establish every time the admin
          switches tabs. */}
      <div className={tab === "board" ? "flex flex-col gap-6" : "hidden"}>{boardContent}</div>
      <div className={tab === "roster" ? "flex flex-col gap-6" : "hidden"}>{rosterContent}</div>
      <div className={tab === "snacks" ? "flex flex-col gap-6" : "hidden"}>{snacksContent}</div>
    </div>
  );
}
