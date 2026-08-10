"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Mode = "phone" | "email";
type PhoneStep = "enter" | "verify";

export function SignInForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const supabase = createClient();

  // Phone sign-in is hidden until an SMS provider is configured in Supabase
  // (see architecture-plan.md) -- the UI below never offers a way to switch
  // to "phone", but the code path is left in place so re-enabling it later
  // is just restoring the toggle button, not rebuilding this form.
  const [mode] = useState<Mode>("email");
  const [phoneStep, setPhoneStep] = useState<PhoneStep>("enter");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendPhoneCode(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({ phone });
    setLoading(false);
    if (error) {
      setError(t("genericError"));
      return;
    }
    setPhoneStep("verify");
  }

  async function verifyPhoneCode(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({ phone, token: code, type: "sms" });
    setLoading(false);
    if (error) {
      setError(t("invalidCode"));
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function sendEmailLink(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` }
    });
    setLoading(false);
    if (error) {
      setError(t("genericError"));
      return;
    }
    setEmailSent(true);
  }

  async function continueWithGoogle() {
    setError(null);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {mode === "phone" ? (
        phoneStep === "enter" ? (
          <form onSubmit={sendPhoneCode} className="flex flex-col gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="phone">
              {t("phoneNumber")}
            </label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              required
              placeholder="+1 234 567 8900"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="rounded-lg border border-slate-300 px-4 py-3"
            />
            <p className="text-xs text-slate-500">{t("phoneHint")}</p>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              {t("sendCode")}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyPhoneCode} className="flex flex-col gap-2">
            <label className="text-sm font-medium text-slate-700" htmlFor="code">
              {t("verificationCode")}
            </label>
            <input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="rounded-lg border border-slate-300 px-4 py-3"
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50"
            >
              {t("verifyCode")}
            </button>
            <button
              type="button"
              onClick={() => {
                setPhoneStep("enter");
                setCode("");
                setError(null);
              }}
              className="text-sm text-slate-500 underline"
            >
              {t("changePhone")}
            </button>
          </form>
        )
      ) : emailSent ? (
        <p className="text-slate-600">{t("checkYourEmail")}</p>
      ) : (
        <form onSubmit={sendEmailLink} className="flex flex-col gap-2">
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
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-slate-900 px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            {t("sendCode")}
          </button>
        </form>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

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
