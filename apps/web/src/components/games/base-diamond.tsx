"use client";

import { useTranslations } from "next-intl";

type Base = "first" | "second" | "third";

function BaseMarker({
  base,
  occupied,
  interactive,
  onToggle,
  className
}: {
  base: Base;
  occupied: boolean;
  interactive: boolean;
  onToggle?: (base: Base, occupied: boolean) => void;
  className: string;
}) {
  const t = useTranslations();

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={() => onToggle?.(base, !occupied)}
      aria-label={t(`game.base.${base}`)}
      aria-pressed={occupied}
      className={`absolute h-6 w-6 rotate-45 border-2 ${
        occupied ? "border-yellow-500 bg-yellow-400" : "border-slate-400 bg-white"
      } ${interactive ? "cursor-pointer" : "cursor-default"} ${className}`}
    />
  );
}

export function BaseDiamond({
  runnerOnFirst,
  runnerOnSecond,
  runnerOnThird,
  onToggleBase,
  battingName,
  pitchingName
}: {
  runnerOnFirst: boolean;
  runnerOnSecond: boolean;
  runnerOnThird: boolean;
  onToggleBase?: (base: Base, occupied: boolean) => void;
  battingName?: string | null;
  pitchingName?: string | null;
}) {
  const interactive = !!onToggleBase;

  return (
    <div className="mx-auto flex flex-col items-center">
      <div className="relative h-40 w-40">
        <div className="absolute inset-0 rotate-45 rounded-sm border-2 border-slate-300" />

        <BaseMarker
          base="second"
          occupied={runnerOnSecond}
          interactive={interactive}
          onToggle={onToggleBase}
          className="left-1/2 top-0 -translate-x-1/2 -translate-y-1/2"
        />
        <BaseMarker
          base="first"
          occupied={runnerOnFirst}
          interactive={interactive}
          onToggle={onToggleBase}
          className="right-0 top-1/2 translate-x-1/2 -translate-y-1/2"
        />
        <BaseMarker
          base="third"
          occupied={runnerOnThird}
          interactive={interactive}
          onToggle={onToggleBase}
          className="left-0 top-1/2 -translate-x-1/2 -translate-y-1/2"
        />

        {/* Pitcher's mound: decorative, centered. Name sits under it. */}
        <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
          <div className="h-3 w-3 rounded-full border-2 border-slate-300 bg-slate-100" />
          {pitchingName && (
            <span className="max-w-[4.5rem] truncate text-center text-[10px] font-medium text-slate-600">
              {pitchingName}
            </span>
          )}
        </div>

        {/* Home plate: decorative only, not a toggleable base. */}
        <div className="absolute bottom-0 left-1/2 h-5 w-5 -translate-x-1/2 translate-y-1/2 rotate-45 border-2 border-slate-400 bg-slate-100" />
      </div>

      {battingName && (
        <span className="mt-3 max-w-[9rem] truncate text-center text-xs font-semibold text-slate-800">
          {battingName}
        </span>
      )}
    </div>
  );
}
