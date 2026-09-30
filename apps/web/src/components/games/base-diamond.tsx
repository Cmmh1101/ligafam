"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { PositionCode } from "@/lib/supabase/database.types";

type Base = "first" | "second" | "third";
export type FielderPosition = Exclude<PositionCode, "P">;

// Canvas is a portrait rectangle (4:5), not a square -- a square canvas
// left no vertical room for outfield above 2nd base and clearance below
// home plate, so home plate got clipped by the canvas's own overflow-hidden
// edge. All geometry below is derived from one square (the basepath, before
// its 45deg rotation) rather than each base/home-plate/dirt-patch carrying
// its own eyeballed position -- that's what made the diamond read as
// slightly lopsided rather than a true, symmetric diamond.
//
// The math: a square of side S, rotated 45deg, reaches S*0.7071 from its
// own center to each corner (the base/home-plate points). Because the
// canvas is taller than it is wide (width W, height 1.25*W), that same
// pixel reach is a smaller percentage of height than of width -- computed
// once here as CANVAS_W_OVER_H -- which is exactly what buys the vertical
// clearance a square canvas didn't have.
const CANVAS_W_OVER_H = 4 / 5;
const DIAMOND_SIDE_PCT = 58; // basepath square's side, as % of canvas width
const DIAMOND_CENTER: { top: number; left: number } = { top: 49, left: 50 };
const HALF_DIAGONAL_X = DIAMOND_SIDE_PCT * 0.7071; // % of width
const HALF_DIAGONAL_Y = DIAMOND_SIDE_PCT * 0.7071 * CANVAS_W_OVER_H; // % of height

const BASE_POSITIONS: Record<Base, { top: string; left: string }> = {
  second: { top: `${DIAMOND_CENTER.top - HALF_DIAGONAL_Y}%`, left: `${DIAMOND_CENTER.left}%` },
  first: { top: `${DIAMOND_CENTER.top}%`, left: `${DIAMOND_CENTER.left + HALF_DIAGONAL_X}%` },
  third: { top: `${DIAMOND_CENTER.top}%`, left: `${DIAMOND_CENTER.left - HALF_DIAGONAL_X}%` }
};

const HOME_PLATE_POSITION = { top: `${DIAMOND_CENTER.top + HALF_DIAGONAL_Y}%`, left: `${DIAMOND_CENTER.left}%` };

const FIELDER_POSITIONS: Record<FielderPosition, { top: string; left: string }> = {
  C: { top: "88%", left: "50%" },
  "1B": { top: "62%", left: "94%" },
  "2B": { top: "28%", left: "64%" },
  "3B": { top: "62%", left: "6%" },
  SS: { top: "28%", left: "36%" },
  LF: { top: "8%", left: "20%" },
  CF: { top: "3%", left: "50%" },
  RF: { top: "8%", left: "80%" }
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
      className={`absolute z-10 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center ${
        interactive ? "cursor-pointer" : "cursor-default"
      }`}
    >
      {/* Runner indicator: a round dot layered behind the bag, not the bag
          itself turning into a solid block -- reads as "someone's here"
          without dominating the diamond. */}
      {occupied && <span className="absolute h-5 w-5 rounded-full bg-amber-400/90" />}
      {/* The bag: a small rotated square, same shape a real base is. */}
      <span
        className={`relative h-4 w-4 rotate-45 border-2 ${
          occupied ? "border-amber-600 bg-white" : "border-slate-400 bg-white"
        }`}
      />
      {runnerName && (
        <span className="absolute top-full mt-0.5 w-14 truncate text-center text-[9px] font-semibold text-slate-800">
          {runnerName}
        </span>
      )}
    </button>
  );
}

function FielderLabel({
  code,
  label,
  position
}: {
  code: FielderPosition;
  label?: string | null;
  position: { top: string; left: string };
}) {
  const t = useTranslations();

  return (
    <div
      style={position}
      className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
      title={t(`positions.${code}`)}
    >
      <span
        className={`rounded px-1 text-[9px] font-semibold ${
          label ? "bg-white/90 text-slate-700" : "bg-white/60 text-slate-400"
        }`}
      >
        {label ?? code}
      </span>
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
  fielderPositions,
  cornerContent
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
  cornerContent?: ReactNode;
}) {
  const interactive = !!onBaseClick;

  return (
    <div className="mx-auto flex w-full flex-col items-center">
      <div className="relative aspect-[4/5] w-full max-w-md overflow-hidden rounded-2xl bg-green-300">
        {/* Infield dirt: a bigger rotated square, same center as the
            basepath, sized/positioned from the same diamond math above. */}
        <div className="absolute left-[15%] top-[21%] z-0 h-[56%] w-[70%] rotate-45 rounded-sm bg-amber-200" />

        {/* Basepath outline: the actual square the corner math is derived
            from -- reads as a chalk line against the dirt. */}
        <div
          className="absolute z-0 rotate-45 rounded-sm border-2 border-white"
          style={{
            left: `${DIAMOND_CENTER.left - DIAMOND_SIDE_PCT / 2}%`,
            top: `${DIAMOND_CENTER.top - (DIAMOND_SIDE_PCT * CANVAS_W_OVER_H) / 2}%`,
            width: `${DIAMOND_SIDE_PCT}%`,
            height: `${DIAMOND_SIDE_PCT * CANVAS_W_OVER_H}%`
          }}
        />

        {(Object.keys(FIELDER_POSITIONS) as FielderPosition[]).map((code) => (
          <FielderLabel
            key={code}
            code={code}
            label={fielderPositions?.[code]}
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

        {/* Pitcher's mound: center of the diamond. Tappable when
            onPitchingNameClick is provided (admin, live game), otherwise a
            plain label -- same shape as the batting name below. */}
        <div
          className="absolute z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
          style={{ left: `${DIAMOND_CENTER.left}%`, top: `${DIAMOND_CENTER.top}%` }}
        >
          <div className="h-3.5 w-3.5 rounded-full border-2 border-amber-500 bg-amber-100" />
          {pitchingName &&
            (onPitchingNameClick ? (
              <button
                type="button"
                onClick={onPitchingNameClick}
                className="max-w-[6rem] truncate rounded bg-white/90 px-1.5 py-0.5 text-center text-xs font-semibold text-slate-700 underline decoration-dotted"
              >
                {pitchingName}
              </button>
            ) : (
              <span className="max-w-[6rem] truncate rounded bg-white/90 px-1.5 py-0.5 text-center text-xs font-semibold text-slate-700">
                {pitchingName}
              </span>
            ))}
        </div>

        {/* Home plate: decorative only, not a toggleable base. Its own
            vertex position already leaves clearance below (down to the
            catcher's spot at 88%) so it never touches the canvas edge. */}
        <div
          className="absolute z-10 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-slate-500 bg-white"
          style={HOME_PLATE_POSITION}
        />

        {cornerContent && <div className="absolute bottom-1 left-1 z-10">{cornerContent}</div>}
      </div>

      {battingName &&
        (onBattingNameClick ? (
          <button
            type="button"
            onClick={onBattingNameClick}
            className="mt-3 max-w-[10rem] truncate text-center text-sm font-bold text-slate-900 underline decoration-dotted"
          >
            {battingName}
          </button>
        ) : (
          <span className="mt-3 max-w-[10rem] truncate text-center text-sm font-bold text-slate-900">
            {battingName}
          </span>
        ))}
    </div>
  );
}
