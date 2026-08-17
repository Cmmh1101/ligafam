import Script from "next/script";
import { GoogleAnalyticsPageview } from "@/components/analytics/google-analytics-pageview";

// No-ops without a measurement ID (mirrors the VAPID/push pattern -- an
// unconfigured deployment just skips the feature instead of breaking) and
// outside production, so local/dev traffic never pollutes real analytics.
export function GoogleAnalytics() {
  const measurementId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  if (!measurementId || process.env.NODE_ENV !== "production") return null;

  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${measurementId}`} strategy="afterInteractive" />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          window.gtag = gtag;
          gtag('js', new Date());
          gtag('config', '${measurementId}', { send_page_view: false });
        `}
      </Script>
      <GoogleAnalyticsPageview measurementId={measurementId} />
    </>
  );
}
