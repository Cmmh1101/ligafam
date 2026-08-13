import webpush from "web-push";
import { createServiceClient } from "@/lib/supabase/service";
import type { NotificationType } from "@/lib/push/claim";

// Lazy, not module-scope: Next.js imports every API route module during its
// build-time "collecting page data" pass (which imports this file via
// /api/cron/reminders), so a module-scope setVapidDetails() call throws and
// fails the ENTIRE production build the moment any one of these env vars is
// missing -- not just at request time on the affected route. Deferring the
// call until a send is actually attempted confines a missing/misconfigured
// var to that one runtime call instead.
let vapidConfigured = false;
function ensureVapidConfigured() {
  if (vapidConfigured) return;
  const subject = process.env.VAPID_SUBJECT;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) {
    throw new Error("Push notifications are not configured (missing VAPID_SUBJECT/VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY)");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  vapidConfigured = true;
}

type Locale = "es" | "en";

// Small fixed set of templates -- kept as a plain map rather than wired
// into next-intl, since this runs outside a request-locale context (cron,
// fan-out to many recipients each with their own preferred_locale).
const TEMPLATES: Record<
  NotificationType,
  (locale: Locale, vars: Record<string, string>) => { title: string; body: string }
> = {
  game_scheduled: (locale, vars) =>
    locale === "en"
      ? { title: "New game scheduled", body: vars.opponent ? `vs. ${vars.opponent}` : "Check the calendar for details" }
      : { title: "Nuevo partido programado", body: vars.opponent ? `vs. ${vars.opponent}` : "Revisa el calendario para más detalles" },
  game_live: (locale, vars) =>
    locale === "en"
      ? { title: "Game is live!", body: vars.opponent ? `vs. ${vars.opponent} -- follow along now` : "Follow along now" }
      : { title: "¡El partido está en vivo!", body: vars.opponent ? `vs. ${vars.opponent} -- síguelo ahora` : "Síguelo ahora" },
  rsvp_reminder: (locale) =>
    locale === "en"
      ? { title: "Reminder: confirm attendance", body: "There's a game or practice tomorrow -- let your team know if you're coming" }
      : { title: "Recordatorio: confirma tu asistencia", body: "Hay un partido o práctica mañana -- avísale a tu equipo si asistirás" },
  snack_reminder: (locale) =>
    locale === "en"
      ? { title: "Snacks needed", body: "Nobody has signed up for snacks for tomorrow's game yet" }
      : { title: "Faltan refrigerios", body: "Todavía nadie se ha anotado para llevar refrigerios al partido de mañana" }
};

export async function sendPushToUsers(
  userIds: string[],
  kind: NotificationType,
  vars: { opponent?: string; url: string }
): Promise<void> {
  if (userIds.length === 0) return;

  ensureVapidConfigured();
  const supabase = createServiceClient();

  const [{ data: profiles }, { data: subscriptions }] = await Promise.all([
    supabase.from("profiles").select("id, preferred_locale").in("id", userIds),
    supabase.from("push_subscriptions").select("id, user_id, endpoint, p256dh, auth_key").in("user_id", userIds)
  ]);

  const localeByUser = new Map((profiles ?? []).map((p) => [p.id, (p.preferred_locale as Locale) ?? "es"]));

  const results = await Promise.allSettled(
    (subscriptions ?? []).map(async (sub) => {
      const locale = localeByUser.get(sub.user_id) ?? "es";
      const { title, body } = TEMPLATES[kind](locale, { opponent: vars.opponent ?? "" });
      const payload = JSON.stringify({ title, body, url: vars.url });

      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          payload
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", sub.id);
        } else {
          throw err;
        }
      }
    })
  );

  for (const result of results) {
    if (result.status === "rejected") console.error("[sendPushToUsers] send failed", result.reason);
  }
}
