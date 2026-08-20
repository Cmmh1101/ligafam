import { getTranslations } from "next-intl/server";

// Decorative preview of the app's own live scoreboard card (mirrors
// game-score-panel.tsx / base-diamond.tsx) -- sample data, not a real game.
export async function LandingHero() {
  const t = await getTranslations("game");

  return (
    <div className="relative flex h-[220px] w-[220px] items-center justify-center">
      <svg
        width="26"
        height="26"
        viewBox="0 0 24 24"
        fill="none"
        className="absolute bottom-3 right-0 -rotate-6"
      >
        <path
          d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z"
          stroke="#cbd5e1"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M17 9.5h1.5a2.5 2.5 0 0 1 0 5H17" stroke="#cbd5e1" strokeWidth="1.5" />
        <path
          d="M8 3.5c0 .8-.7 1-.7 1.8S8 6.5 8 7.3M11.5 3.5c0 .8-.7 1-.7 1.8S11.5 6.5 11.5 7.3"
          stroke="#cbd5e1"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>

      <div className="relative -rotate-3 rounded-[22px] bg-slate-900 p-2 shadow-xl shadow-slate-900/30">
        <div className="flex h-[240px] w-[144px] flex-col gap-2.5 rounded-[16px] bg-white p-3">
          <div className="flex flex-col gap-2 rounded-lg border border-slate-200 p-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-[8px] font-medium uppercase text-slate-500">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-600" />
                {t("live")}
              </span>
              <span className="text-[8px] text-slate-500">
                {t("top")} &middot; {t("inning")} 3
              </span>
            </div>

            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
              <div className="flex flex-col items-center">
                <span className="text-[15px] font-semibold text-slate-900">4</span>
                <span className="text-[7px] text-slate-500">{t("us")}</span>
              </div>

              <div className="relative h-8 w-8">
                <span className="absolute bottom-0 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 border-[1.5px] border-slate-400 bg-white" />
                <span className="absolute right-0 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-[1.5px] border-yellow-500 bg-yellow-400" />
                <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rotate-45 border-[1.5px] border-slate-400 bg-white" />
                <span className="absolute left-0 top-1/2 h-2 w-2 -translate-y-1/2 rotate-45 border-[1.5px] border-slate-400 bg-white" />
              </div>

              <div className="flex flex-col items-center">
                <span className="text-[15px] font-semibold text-slate-900">2</span>
                <span className="text-[7px] text-slate-500">Tigers</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-900" />
                <span className="h-1.5 w-1.5 rounded-full bg-slate-900" />
                <span className="h-1.5 w-1.5 rounded-full bg-slate-200" />
              </div>
              <span className="text-[8px] text-slate-500">{t("count")}: 2-1</span>
            </div>
          </div>

          <div className="mt-0.5 flex flex-col gap-1">
            <div className="h-1 w-full rounded-full bg-slate-100" />
            <div className="h-1 w-[70%] rounded-full bg-slate-100" />
          </div>
        </div>
      </div>
    </div>
  );
}
