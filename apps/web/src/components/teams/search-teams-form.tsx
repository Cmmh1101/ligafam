"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";

type SearchResult = {
  id: string;
  name: string;
  sport: string;
  age_group: string | null;
};

type Membership = { teamId: string; status: string };

export function SearchTeamsForm({
  locale,
  memberships
}: {
  locale: string;
  memberships: Membership[];
}) {
  const t = useTranslations();
  const supabase = createClient();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);

  const statusByTeamId = new Map(memberships.map((m) => [m.teamId, m.status]));

  async function submitSearch(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    const { data } = await supabase.rpc("search_teams", { p_query: query.trim() });
    setLoading(false);
    setResults(data ?? []);
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={submitSearch} className="flex gap-2">
        <input
          type="text"
          required
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("team.searchPlaceholder")}
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-4 py-3"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50"
        >
          {t("team.searchButton")}
        </button>
      </form>

      {results !== null && (
        <ul className="flex flex-col gap-2">
          {results.length === 0 && <p className="text-slate-600">{t("team.noSearchResults")}</p>}
          {results.map((team) => {
            const status = statusByTeamId.get(team.id);
            return (
              <li
                key={team.id}
                className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-4 py-3"
              >
                <div className="flex flex-col">
                  <span className="font-medium text-slate-900">{team.name}</span>
                  {team.age_group && <span className="text-xs text-slate-500">{team.age_group}</span>}
                </div>

                {status === "approved" ? (
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                    {t("errors.alreadyMember")}
                  </span>
                ) : status === "pending" ? (
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                    {t("team.statusPending")}
                  </span>
                ) : (
                  <a
                    href={`/${locale}/teams/join?teamId=${team.id}&teamName=${encodeURIComponent(team.name)}`}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {t("team.joinThisTeam")}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
