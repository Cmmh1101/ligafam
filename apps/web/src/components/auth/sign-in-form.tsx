"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "login" | "register" | "forgot";

function authErrorKey(message: string | undefined): string {
  if (!message) return "genericError";
  if (message.includes("Invalid login credentials")) return "invalidCredentials";
  if (message.includes("already registered") || message.includes("already exists")) {
    return "emailAlreadyRegistered";
  }
  if (message.toLowerCase().includes("password")) return "passwordTooShort";
  return "genericError";
}

export function SignInForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const supabase = createClient();

  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [resetEmailSent, setResetEmailSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setResetEmailSent(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const { error } =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });

    setLoading(false);
    if (error) {
      setError(t(authErrorKey(error.message)));
      return;
    }

    router.push("/");
    router.refresh();
  }

  async function sendResetLink(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // resetPasswordForEmail intentionally doesn't reveal whether the email
    // exists (anti-enumeration) -- errors here are transport/rate-limit
    // failures, not "no such account".
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`
    });

    setLoading(false);
    if (error) {
      setError(t(authErrorKey(error.message)));
      return;
    }
    setResetEmailSent(true);
  }

  async function continueWithGoogle() {
    setError(null);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` }
    });
  }

  if (mode === "forgot") {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold text-slate-900">{t("forgotPassword")}</h1>

        {resetEmailSent ? (
          <p className="text-slate-600">{t("checkEmailForReset")}</p>
        ) : (
          <form onSubmit={sendResetLink} className="flex flex-col gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="reset-email">
              {t("emailAddress")}
            </label>
            <input
              id="reset-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-slate-300 px-4 py-3"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              {t("sendResetLink")}
            </button>
          </form>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="button"
          onClick={() => switchMode("login")}
          className="text-sm text-slate-500 underline"
        >
          {t("backToSignIn")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-slate-900">
        {mode === "login" ? t("signIn") : t("signUp")}
      </h1>

      <form onSubmit={submit} className="flex flex-col gap-2">
        <label className="text-sm font-medium text-slate-700" htmlFor="email">
          {t("emailAddress")}
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border border-slate-300 px-4 py-3"
        />

        <label className="text-sm font-medium text-slate-700" htmlFor="password">
          {t("password")}
        </label>
        <input
          id="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-slate-300 px-4 py-3"
        />
        {mode === "register" && <p className="text-xs text-slate-500">{t("passwordHint")}</p>}

        {mode === "login" && (
          <button
            type="button"
            onClick={() => switchMode("forgot")}
            className="self-end text-xs text-slate-500 underline"
          >
            {t("forgotPassword")}
          </button>
        )}

        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50"
        >
          {mode === "login" ? t("signIn") : t("signUp")}
        </button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="button"
        onClick={() => switchMode(mode === "login" ? "register" : "login")}
        className="text-sm text-slate-500 underline"
      >
        {mode === "login" ? t("needAccount") : t("haveAccount")}
      </button>

      <div className="flex items-center gap-3 text-xs text-slate-400">
        <div className="h-px flex-1 bg-slate-200" />
        {t("or")}
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      <button
        type="button"
        onClick={continueWithGoogle}
        className="rounded-lg border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
      >
        {t("continueWithGoogle")}
      </button>
    </div>
  );
}
