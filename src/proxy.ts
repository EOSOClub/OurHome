import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { isHttpsRequest } from '@/server/security/network';

// Next.js 16 renamed `middleware` -> `proxy` (nodejs runtime). This file does two
// things on every page request:
//
//   1. An OPTIMISTIC auth gate: if there's no session cookie, protected pages
//      redirect to /login. Cookie presence is not proof of a valid session, so
//      this is only the negative gate — authoritative checks happen in Server
//      Components via requireUser(). It must NOT do the positive bounce (cookie
//      present -> /dashboard), or a stale cookie would ping-pong forever.
//
//   2. A per-request Content-Security-Policy with a fresh nonce. Next reads the
//      nonce from the request CSP header and applies it to its framework
//      scripts; our one inline script (the theme bootstrap in app/layout.tsx)
//      reads `x-nonce` and sets nonce={...} itself. script-src is locked to
//      nonce + strict-dynamic (real XSS defense); style-src keeps 'unsafe-inline'
//      for inline style={} (category colors); img-src https: allows external
//      product/preview thumbnails. Set CSP_REPORT_ONLY=true to switch to the
//      Report-Only header if a violation ever needs investigating.

const PUBLIC_PATHS = [
  // First-run setup. The page itself sends visitors away once setup is done.
  '/setup',
  '/login',
  '/forgot-password',
  '/reset-password',
  '/no-household',
];

// Cloudflare Turnstile (the contact-form CAPTCHA) is loaded from this origin.
// script-src: the host is a no-op for browsers honoring 'strict-dynamic' (the
// nonce on api.js authorizes it and its injected scripts propagate), but kept for
// older browsers. frame-src: the widget renders in an iframe (would otherwise fall
// back to default-src 'self' and be blocked). connect-src: the widget's XHR.
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';

function buildCsp(nonce: string, https: boolean): string {
  const isDev = process.env.NODE_ENV === 'development';
  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TURNSTILE_ORIGIN}${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self'`,
    `connect-src 'self' ${TURNSTILE_ORIGIN}${isDev ? ' ws:' : ''}`,
    `frame-src ${TURNSTILE_ORIGIN}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  // Only over HTTPS: on plain-HTTP home-network access it would rewrite every
  // script and stylesheet to an https:// URL nothing is listening on.
  if (https) directives.push(`upgrade-insecure-requests`);
  return directives.join('; ');
}

function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  const hasSession = !!getSessionCookie(request);

  // Unauthenticated access to a protected page -> login. (No CSP needed on a
  // bodyless redirect.)
  if (!hasSession && !isPublic) {
    const url = new URL('/login', request.url);
    url.searchParams.set('redirect', pathname);
    return NextResponse.redirect(url);
  }

  const nonce = generateNonce();
  const csp = buildCsp(nonce, isHttpsRequest(request.headers, request.url));
  const headerName =
    process.env.CSP_REPORT_ONLY === 'true'
      ? 'Content-Security-Policy-Report-Only'
      : 'Content-Security-Policy';

  // Forward the nonce + CSP on the request so Next nonces its own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, csp);
  return response;
}

export const config = {
  // Guard pages only. API routes (including /api/auth) authenticate themselves
  // and return JSON 401s via withAuth, so they're excluded here. Also skip Next
  // internals, static assets, and link prefetches (which don't need a CSP).
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
