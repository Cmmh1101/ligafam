"use client";

import { useTranslations } from "next-intl";
import type { PositionCode } from "@/lib/supabase/database.types";

type Base = "first" | "second" | "third";
export type FielderPosition = Exclude<PositionCode, "P">;

// Percent-of-canvas coordinates. The diamond (2nd/1st/3rd/home) keeps the
// exact same relative shape the old 160x160 box used -- a square rotated
// 45deg, corners at the midpoints of its own bounding box -- just scaled up
// and shifted into the lower ~70% of the new, bigger canvas so there's room
// for the outfield above it. Fielder spots are offset out from their base
// (a fielder stands near, not on, the bag) rather than reusing the base's
// own coordinates.
const BASE_POSITIONS: Record<Base, { top: string; left: string }> = {
  second: { top: "31%", left: "50%" },
  first: { top: "65%", left: "85%" },
  third: { top: "65%", left: "15%" }
};

const FIELDER_POSITIONS: Record<FielderPosition, { top: string; left: string }> = {
  C: { top: "88%", left: "50%" },
  "1B": { top: "58%", left: "90%" },
  "2B": { top: "42%", left: "64%" },
  "3B": { top: "58%", left: "10%" },
  SS: { top: "42%", left: "36%" },
  LF: { top: "10%", left: "18%" },
  CF: { top: "4%", left: "50%" },
  RF: { top: "10%", left: "82%" }
};

function BaseMarker({
  base,
  occupied,
  runnerName,
  interactive,
  onClick,
  position
}: {
  base: Base;
  occupied: boolean;
  runnerName?: string | null;
  interactive: boolean;
  onClick?: (base: Base, occupied: boolean) => void;
  position: { top: string; left: string };
}) {
  const t = useTranslations();

  return (
    <button
      type="button"
      disabled={!interactive}
      onClick={() => onClick?.(base, occupied)}
      aria-label={runnerName ? `${t(`game.base.${base}`)}: ${runnerName}` : t(`game.base.${base}`)}
      aria-pressed={occupied}
      style={position}
      className={`absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 rotate-45 items-center justify-center border-2 ${
        occupied ? "border-yellow-500 bg-yellow-400" : "border-slate-400 bg-white"
      } ${interactive ? "cursor-pointer" : "cursor-default"}`}
    >
      {runnerName && (
        <span className="absolute w-14 -rotate-45 truncate text-center text-[9px] font-semibold text-slate-800">
          {runnerName}
        </span>
      )}
    </button>
  );
}

function FielderLabel({
  code,
  playerName,
  position
}: {
  code: FielderPosition;
  playerName?: string | null;
  position: { top: string; left: string };
}) {
  const t = useTranslations();

  return (
    <div
      style={position}
      className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-0.5"
      title={t(`positions.${code}`)}
    >
      <span
        className={`rounded px-1 text-[9px] font-semibold ${
          playerName ? "bg-slate-100 text-slate-700" : "text-slate-300"
        }`}
      >
        {code}
      </span>
      {playerName && (
        <span className="max-w-[3.5rem] truncate text-center text-[9px] text-slate-600">{playerName}</span>
      )}
    </div>
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
  onBattingNameClick,
  onPitchingNameClick,
  fielderPositions
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
  onPitchingNameClick?: () => void;
  fielderPositions?: Partial<Record<FielderPosition, string | null>>;
}) {
  const interactive = !!onBaseClick;

  return (
    <div className="mx-auto flex flex-col items-center">
      <div className="relative h-72 w-72">
        {/* Diamond outline: same rotated-square shape as before, sized to
            the sub-box spanning from the "2nd" corner down to home. */}
        <div className="absolute left-[15%] top-[30.6%] h-[69.4%] w-[70%] rotate-45 rounded-sm border-2 border-slate-300" />

        {(Object.keys(FIELDER_POSITIONS) as FielderPosition[]).map((code) => (
          <FielderLabel
            key={code}
            code={code}
            playerName={fielderPositions?.[code]}
            position={FIELDER_POSITIONS[code]}
          />
        ))}

        <BaseMarker
          base="second"
          occupied={runnerOnSecond}
          runnerName={runnerOnSecondName}
          interactive={interactive}
          onClick={onBaseClick}
          position={BASE_POSITIONS.second}
        />
        <BaseMarker
          base="first"
          occupied={runnerOnFirst}
          runnerName={runnerOnFirstName}
          interactive={interactive}
          onClick={onBaseClick}
          position={BASE_POSITIONS.first}
        />
        <BaseMarker
          base="third"
          occupied={runnerOnThird}
          runnerName={runnerOnThirdName}
          interactive={interactive}
          onClick={onBaseClick}
          position={BASE_POSITIONS.third}
        />

        {/* Pitcher's mound: center of the diamond sub-box. Tappable when
            onPitchingNameClick is provided (admin, live game), otherwise a
            plain label -- same shape as the batting name below. */}
        <div className="absolute left-1/2 top-[65%] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1">
          <div className="h-3 w-3 rounded-full border-2 border-slate-300 bg-slate-100" />
          {pitchingName &&
            (onPitchingNameClick ? (
              <button
                type="button"
                onClick={onPitchingNameClick}
                className="max-w-[4.5rem] truncate text-center text-[10px] font-medium text-slate-600 underline decoration-dotted"
              >
                {pitchingName}
              </button>
            ) : (
              <span className="max-w-[4.5rem] truncate text-center text-[10px] font-medium text-slate-600">
                {pitchingName}
              </span>
            ))}
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
