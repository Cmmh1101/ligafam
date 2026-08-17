"use client";

import { useTranslations } from "next-intl";

type Base = "first" | "second" | "third";

function BaseMarker({
  base,
  occupied,
  runnerName,
  interactive,
  onClick,
  className
}: {
  base: Base;
  occupied: boolean;
  runnerName?: string | null;
  interactive: boolean;
  onClick?: (base: Base, occupied: boolean) => void;
  className: string;
}) {
  const t = useTranslations();

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={() => onClick?.(base, occupied)}
      aria-label={runnerName ? `${t(`game.base.${base}`)}: ${runnerName}` : t(`game.base.${base}`)}
      aria-pressed={occupied}
      className={`absolute flex h-6 w-6 rotate-45 items-center justify-center border-2 ${
        occupied ? "border-yellow-500 bg-yellow-400" : "border-slate-400 bg-white"
      } ${interactive ? "cursor-pointer" : "cursor-default"} ${className}`}
    >
      {runnerName && (
        <span className="absolute w-14 -rotate-45 truncate text-center text-[9px] font-semibold text-slate-800">
          {runnerName}
        </span>
      )}
    </button>
  );
}

export function BaseDiamond({
  runnerOnFirst,
  runnerOnSecond,
  runnerOnThird,
  runnerOnFirstName,
  runnerOnSecondName,
  runnerOnThirdName,
  onBaseClick,
  battingName,
  pitchingName,
  onBattingNameClick
}: {
  runnerOnFirst: boolean;
  runnerOnSecond: boolean;
  runnerOnThird: boolean;
  runnerOnFirstName?: string | null;
  runnerOnSecondName?: string | null;
  runnerOnThirdName?: string | null;
  onBaseClick?: (base: Base, occupied: boolean) => void;
  battingName?: string | null;
  pitchingName?: string | null;
  onBattingNameClick?: () => void;
}) {
  const interactive = !!onBaseClick;

  return (
    <div className="mx-auto flex flex-col items-center">
      <div className="relative h-40 w-40">
        <div className="absolute inset-0 rotate-45 rounded-sm border-2 border-slate-300" />

        <BaseMarker
          base="second"
          occupied={runnerOnSecond}
          runnerName={runnerOnSecondName}
          interactive={interactive}
          onClick={onBaseClick}
          className="left-1/2 top-0 -translate-x-1/2 -translate-y-1/2"
        />
        <BaseMarker
          base="first"
          occupied={runnerOnFirst}
          runnerName={runnerOnFirstName}
          interactive={interactive}
          onClick={onBaseClick}
          className="right-0 top-1/2 translate-x-1/2 -translate-y-1/2"
        />
        <BaseMarker
          base="third"
          occupied={runnerOnThird}
          runnerName={runnerOnThirdName}
          interactive={interactive}
          onClick={onBaseClick}
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

      {battingName &&
        (onBattingNameClick ? (
          <button
            type="button"
            onClick={onBattingNameClick}
            className="mt-3 max-w-[9rem] truncate text-center text-xs font-semibold text-slate-800 underline decoration-dotted"
          >
            {battingName}
          </button>
        ) : (
          <span className="mt-3 max-w-[9rem] truncate text-center text-xs font-semibold text-slate-800">
            {battingName}
          </span>
        ))}
    </div>
  );
}
