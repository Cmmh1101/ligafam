import { NextIntlClientProvider } from "next-intl";
import { getMessages, getLocale } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { OfflineBanner } from "@/components/offline-banner";
import { NotificationNudge } from "@/components/notifications/notification-nudge";
import { ToastProvider } from "@/components/toast/toast-context";
import { ToastContainer } from "@/components/toast/toast-container";
import { ToastFromSearchParam } from "@/components/toast/toast-from-search-param";
import "./globals.css";

export const metadata: Metadata = {
  title: "LigaFam",
  description: "Tu equipo, tu temporada, tu idioma.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "LigaFam"
  },
  // Next's appleWebApp.capable only emits the modern "mobile-web-app-capable"
  // tag -- iOS Safari versions before 16.4 only honor the apple-prefixed one
  // for standalone "Add to Home Screen" mode, so it's added explicitly here.
  other: {
    "apple-mobile-web-app-capable": "yes"
  }
};

export const viewport: Viewport = {
  themeColor: "#0f172a"
};

// The true root layout — Next.js requires <html>/<body> to live here, since
// this wraps every route including ones outside [locale] (e.g. a mistaken
// redirect landing on "/"). Locale resolution is cookie-based (see
// src/i18n/request.ts), not route-param-based, so this works the same
// regardless of which route segment triggered the render.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ToastProvider>
            <OfflineBanner />
            {children}
            <NotificationNudge />
            <ToastContainer />
            <Suspense fallback={null}>
              <ToastFromSearchParam />
            </Suspense>
          </ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
