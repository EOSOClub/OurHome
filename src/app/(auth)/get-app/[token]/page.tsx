import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import { Download, Smartphone } from 'lucide-react';
import { APP_NAME } from '@/server/config';
import { getAppRelease } from '@/server/services/appDownloadService';
import { appOpenLink, resolveSetupLink, SETUP_LINK_HOURS, setupBaseUrl } from '@/server/services/setupLinkService';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// What a setup link (the QR code in Set up a child) opens on a child's phone,
// without signing in: download the app, install it, then open it with their
// username filled in. Public (proxy.ts); the token in the address is the key.

export const metadata: Metadata = {
  title: 'Get the app',
  robots: { index: false, follow: false },
  // The token is in this page's address: never pass it on.
  referrer: 'no-referrer',
};

export default async function GetAppPage({ params }: { params: Promise<{ token: string }> }) {
  // Per request: the link lives in the database and can end at any time.
  await connection();
  const { token } = await params;
  const link = await resolveSetupLink(token);

  if (!link) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">This setup link has ended</CardTitle>
            <CardDescription>
              A setup link works for {SETUP_LINK_HOURS} hours, until a new one is made, or until the phone it was for
              is signed in. Ask the adult setting up your phone for a new one.
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  const release = getAppRelease();
  const sizeMb = release ? Math.max(1, Math.round(release.sizeBytes / 1_000_000)) : 0;
  // The address the app signs in to; this page's own address when nothing better is set.
  const h = await headers();
  const server = setupBaseUrl(`${h.get('x-forwarded-proto') ?? 'http'}://${h.get('x-forwarded-host') ?? h.get('host')}`);
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Smartphone className="size-6" />
          </div>
          <CardTitle className="text-xl">
            {APP_NAME} for {link.name}
          </CardTitle>
          <CardDescription>{link.householdName}</CardDescription>
        </CardHeader>
        <CardContent>
          {release ? (
            <ol className="list-decimal space-y-4 pl-5 text-sm">
              <li className="space-y-2">
                <p>Download the app.</p>
                <a
                  href={`/api/app/setup-download?token=${encodeURIComponent(token)}`}
                  className={cn(buttonVariants(), 'w-full')}
                >
                  <Download className="size-4" /> Download for Android ({sizeMb} MB)
                </a>
              </li>
              <li>Open the downloaded file to install it. Android asks once to allow installs from this browser.</li>
              <li className="space-y-2">
                <p>
                  Come back here and open it. Your username, <strong>{link.username}</strong>, is filled in.
                </p>
                <a href={appOpenLink(link.username, server)} className={cn(buttonVariants({ variant: 'outline' }), 'w-full')}>
                  Open {APP_NAME}
                </a>
              </li>
              <li>
                Sign in with the temporary password from the adult setting up your phone, then choose your own.{' '}
                <strong>Set up this phone</strong> opens next: do it together.
              </li>
            </ol>
          ) : (
            <p className="text-sm text-muted-foreground">
              This server hasn’t built the Android app yet, so there’s nothing to download. Ask whoever runs your
              server.
            </p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
