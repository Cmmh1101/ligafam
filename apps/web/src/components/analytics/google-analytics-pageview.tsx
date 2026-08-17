"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

// gtag's initial 'config' call (in google-analytics.tsx) only fires once at
// script load -- with send_page_view: false, this effect is what actually
// reports each view, including client-side route changes the App Router
// does without a full reload (locale switches, team/event navigation, etc).
export function GoogleAnalyticsPageview({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!window.gtag) return;
    const query = searchParams.toString();
    window.gtag("event", "page_view", {
      page_path: query ? `${pathname}?${query}` : pathname,
      send_to: measurementId
    });
  }, [pathname, searchParams, measurementId]);

  return null;
}
