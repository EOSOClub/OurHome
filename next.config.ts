import type { NextConfig } from "next";

// Static security headers applied to every response. The Content-Security-Policy
// is NOT here — it needs a per-request nonce and is set in src/proxy.ts.
const securityHeaders = [
  // HTTPS-only deployment: tell browsers to stick to HTTPS. (No `preload` to
  // avoid an irreversible all-subdomains commitment.)
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  // Block MIME-type sniffing.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Clickjacking protection (legacy companion to CSP frame-ancestors 'none').
  { key: "X-Frame-Options", value: "DENY" },
  // Don't leak full URLs to other origins.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Drop powerful features the app doesn't use.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const nextConfig: NextConfig = {
  // Don't advertise the framework.
  poweredByHeader: false,
  // Dev-only: allow the app to be opened from the LAN (e.g. a phone) instead of
  // just localhost. Without this, Next 16 blocks cross-origin requests to its
  // internal /_next/* dev resources, which breaks client JS, HMR, and the RSC
  // navigation that runs after sign-in — making mobile login appear to fail.
  // Wildcards cover common private subnets so a DHCP IP change doesn't break it.
  allowedDevOrigins: ['192.168.*', '10.*', '172.16.*'],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
