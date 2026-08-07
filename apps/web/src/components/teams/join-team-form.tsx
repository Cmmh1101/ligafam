"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { rpcErrorKey } from "@/lib/supabase/rpc-errors";

type Step = "code" | "roster" | "done";
type Role = "family" | "fan";

type RosterPlayer = {
  player_id: string;
  first_name: string;
  last_name: string;
  jersey_number: string | null;
};

export function JoinTeamForm() {
  const t = useTranslations();
  const router = useRouter();
  const supabase = createClient();

  const [step, setStep] = useState<Step>("code");
  const [inviteCode, setInviteCode] = useState("");
  const [role, setRole] = useState<Role>("family");
  const [teamName, setTeamName] = useState("");
  const [roster, setRoster] = useState<RosterPlayer[]>([]);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const code = inviteCode.trim();

    const { data: teamRows, error: teamError } = await supabase.rpc("get_joinable_team", {
      p_invite_code: code
    });

    if (teamError) {
      setLoading(false);
      setError(t(rpcErrorKey(teamError.message)));
      return;
    }
    if (!teamRows || teamRows.length === 0) {
      setLoading(false);
      setError(t("errors.invalidInviteCode"));
      return;
    }

    setTeamName(teamRows[0].name);

    if (role === "fan") {
      const { error: joinError } = await supabase.rpc("request_to_join_team", {
        p_invite_code: code,
        p_role: "fan"
      });
      setLoading(false);
      if (joinError) {
        setError(t(rpcErrorKey(joinError.message)));
        return;
      }
      setStep("done");
      return;
    }

    const { data: rosterRows, error: rosterError } = await supabase.rpc("get_joinable_roster", {
      p_invite_code: code
    });

    setLoading(false);
    if (rosterError) {
      setError(t(rpcErrorKey(rosterError.message)));
      return;
    }

    setRoster(rosterRows ?? []);
    setStep("roster");
  }

  function togglePlayer(id: string) {
    setSelectedPlayerIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  async function submitFamilyRequest(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error: joinError } = await supabase.rpc("request_to_join_team", {
      p_invite_code: inviteCode.trim(),
      p_role: "family",
      p_player_ids: selectedPlayerIds
    });

    setLoading(false);
    if (joinError) {
      setError(t(rpcErrorKey(joinError.message)));
      return;
    }
    setStep("done");
  }

  if (step === "done") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-slate-600">{t("team.pendingApproval")}</p>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white"
        >
          {t("common.continue")}
        </button>
      </div>
    );
  }

  if (step === "roster") {
    return (
      <form onSubmit={submitFamilyRequest} className="flex flex-col gap-4">
        <p className="text-sm text-slate-500">{teamName}</p>
        <p className="text-sm font-medium text-slate-700">{t("team.selectYourKid")}</p>

        {roster.length === 0 ? (
          <p className="text-slate-600">{t("team.noPlayersYet")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {roster.map((player) => (
              <li key={player.player_id}>
                <label className="flex items-center gap-3 rounded-lg border border-slate-300 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectedPlayerIds.includes(player.player_id)}
                    onChange={() => togglePlayer(player.player_id)}
                  />
                  <span>
                    {player.first_name} {player.last_name}
                    {player.jersey_number ? ` #${player.jersey_number}` : ""}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading || selectedPlayerIds.length === 0}
          className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50"
        >
          {t("common.continue")}
        </button>
        <button
          type="button"
          onClick={() => setStep("code")}
          className="text-sm text-slate-500 underline"
        >
          {t("common.back")}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submitCode} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="inviteCode">
          {t("team.enterInviteCode")}
        </label>
        <input
          id="inviteCode"
          type="text"
          required
          value={inviteCode}
          onChange={(e) => setInviteCode(e.target.value)}
          className="rounded-lg border border-slate-300 px-4 py-3"
        />
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-slate-700">{t("team.chooseRole")}</p>
        <div className="flex gap-3">
          <label className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-3">
            <input
              type="radio"
              name="role"
              checked={role === "family"}
              onChange={() => setRole("family")}
            />
            {t("roles.family")}
          </label>
          <label className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-300 px-4 py-3">
            <input
              type="radio"
              name="role"
              checked={role === "fan"}
              onChange={() => setRole("fan")}
            />
            {t("roles.fan")}
          </label>
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50"
      >
        {t("common.continue")}
      </button>
    </form>
  );
}
