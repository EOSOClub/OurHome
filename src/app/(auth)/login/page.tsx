import { Suspense } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@/server/auth/session';
import { APP_NAME } from '@/server/config';
import { ContactDialog } from '@/components/contact/contact-dialog';
import { LoginForm } from './login-form';

// Only follow same-origin, absolute-path redirect targets. Anything else
// (external URLs, protocol-relative `//host`) falls back to the dashboard to
// avoid an open-redirect.
function safeRedirect(target: string | undefined): string {
  if (target && target.startsWith('/') && !target.startsWith('//')) {
    return target;
  }
  return '/dashboard';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  // Authoritative "already signed in -> skip the login form" check. This used to
  // live in proxy.ts, but the proxy only sees that a session cookie *exists*,
  // not that it's valid. A stale cookie there caused an infinite redirect loop
  // (proxy bounced /login -> /dashboard, then requireUser() bounced it back).
  // Validating the real session here breaks that cycle.
  const session = await getServerSession();
  if (session?.user) {
    const { redirect: redirectTo } = await searchParams;
    redirect(safeRedirect(redirectTo));
  }

  // Nonce (from the CSP in src/proxy.ts) lets the Turnstile script load under our
  // strict script-src; the site key is passed to the client as a prop so it never
  // needs the NEXT_PUBLIC_ env convention.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY;

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-4">
        <Suspense>
          <LoginForm appName={APP_NAME} />
        </Suspense>
        <ContactDialog siteKey={turnstileSiteKey} nonce={nonce} />
      </div>
    </main>
  );
}
