import { getTranslations, getLocale } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { acceptAdminInviteAction } from "./accept-action";

export default async function AdminInvitePage({
  params,
  searchParams
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const locale = await getLocale();
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  const t = await getTranslations();
  const { error } = await searchParams;

  // get_admin_invite is callable pre-auth (granted to anon) -- the whole
  // point is a not-yet-registered invitee needs to see which team and
  // which email to register with before they have a session at all.
  const { data: inviteRows } = await supabase.rpc("get_admin_invite", { p_token: token });
  const invite = inviteRows?.[0];

  if (!invite) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <p className="text-slate-600">{t("adminInvite.notFound")}</p>
        <a href={`/${locale}`} className="text-sm text-slate-500 underline">
          {t("common.back")}
        </a>
      </main>
    );
  }

  const acceptInvite = acceptAdminInviteAction.bind(null, locale, token);
  const emailMatches = user?.email?.toLowerCase() === invite.invited_email.toLowerCase();

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold text-slate-900">{t("adminInvite.title")}</h1>
      <p className="text-slate-600">{t("adminInvite.description", { teamName: invite.team_name })}</p>

      {error && <p className="text-sm text-red-600">{t(error)}</p>}

      {invite.status === "accepted" ? (
        <p className="text-slate-600">{t("adminInvite.alreadyAccepted")}</p>
      ) : invite.status === "revoked" ? (
        <p className="text-slate-600">{t("adminInvite.revoked")}</p>
      ) : !user ? (
        <>
          <p className="text-slate-600">
            {t("adminInvite.signInPrompt", { email: invite.invited_email })}
          </p>
          <a
            href={`/${locale}/sign-in?next=${encodeURIComponent(`/${locale}/admin-invite/${token}`)}`}
            className="rounded-lg bg-slate-900 px-4 py-3 text-center font-medium text-white"
          >
            {t("auth.signIn")}
          </a>
        </>
      ) : !emailMatches ? (
        <p className="text-slate-600">
          {t("adminInvite.wrongAccount", { email: invite.invited_email })}
        </p>
      ) : (
        <form action={acceptInvite}>
          <button
            type="submit"
            className="w-full rounded-lg bg-slate-900 px-4 py-3 font-medium text-white"
          >
            {t("adminInvite.accept")}
          </button>
        </form>
      )}
    </main>
  );
}
