import { Suspense } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getServerSession } from '@/server/auth/session';
import { APP_NAME } from '@/server/config';
import { needsSetup } from '@/server/services/setupService';
import { isRefusedPlainHttp } from '@/server/services/accessService';
import { Lock } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
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
  // A fresh install has no one to sign in as: send the first visitor to setup.
  if (await needsSetup()) redirect('/setup');

  // "HTTPS only": don't offer a form whose password would cross the network
  // unencrypted (the auth API refuses it anyway).
  const requestHeaders = await headers();
  if (await isRefusedPlainHttp(requestHeaders)) {
    const httpsUrl = process.env.BETTER_AUTH_URL?.startsWith('https://')
      ? process.env.BETTER_AUTH_URL
      : null;
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Lock className="size-6" />
            </div>
            <CardTitle className="text-xl">HTTPS only</CardTitle>
            <CardDescription>
              {APP_NAME} doesn’t accept sign-in over an unencrypted connection.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {httpsUrl ? (
              <a href={httpsUrl} className={cn(buttonVariants(), 'w-full')}>
                Open the secure address
              </a>
            ) : null}
            <p className="text-muted-foreground">
              On the server itself, <code>http://localhost</code> still works. Your
              Head of House can change this under Settings → Security.
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  const session = await getServerSession();
  if (session?.user) {
    const { redirect: redirectTo } = await searchParams;
    redirect(safeRedirect(redirectTo));
  }

  // Nonce (from the CSP in src/proxy.ts) lets the Turnstile script load under our
  // strict script-src; the site key is passed to the client as a prop so it never
  // needs the NEXT_PUBLIC_ env convention.
  const nonce = requestHeaders.get('x-nonce') ?? undefined;
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
