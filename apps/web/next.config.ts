import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import withSerwistInit from "@serwist/next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // Precache the app shell; runtime caching strategies live in sw.ts
  reloadOnOnline: true
});

const nextConfig: NextConfig = {
  reactStrictMode: true
};

export default withSerwist(withNextIntl(nextConfig));
