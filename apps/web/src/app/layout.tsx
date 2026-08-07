import { NextIntlClientProvider } from "next-intl";
import { getMessages, getLocale } from "next-intl/server";
import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LigaFam",
  description: "Tu equipo, tu temporada, tu idioma.",
  manifest: "/manifest.json"
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
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
