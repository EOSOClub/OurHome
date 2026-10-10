import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { History, Home, ServerCog, Settings, Users, UserRound } from 'lucide-react';
import { requireUser } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getAccessSettings } from '@/server/services/accessService';
import { isServerAdmin } from '@/server/services/serverAdminService';
import { AccessPrompt } from '@/components/settings/access-settings';
import { can } from '@/lib/permissions';
import { AppNav } from '@/components/app-nav';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { ReportBugButton } from '@/components/report-bug-button';
import { ThemeToggle } from '@/components/theme-toggle';
import { SignOutButton } from '@/components/sign-out-button';
import { buttonVariants } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getPointsSettings } from '@/server/services/pointsService';
import { HouseholdZoneProvider } from '@/components/household-zone';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  // Force temp-password accounts to choose their own password before using the
  // app. The session flag can lag (cookie cache) just after a change, so we only
  // pay a DB read when the flag is set, then trust the authoritative value.
  if (user.mustChangePassword) {
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { mustChangePassword: true },
    });
    if (fresh?.mustChangePassword) redirect('/change-password');
  }

  // Until the server admin chooses how the site may be reached, ask them on
  // every page (first shown right after setup).
  const serverAdmin = await isServerAdmin(user.id);
  const access = serverAdmin ? await getAccessSettings(await headers()) : null;
  // Every date on the pages is shown in the household's zone (see
  // HouseholdZoneProvider), so server and browser render the same text.
  const { timezone } = await getPointsSettings(user.householdId!);

  return (
    <HouseholdZoneProvider timeZone={timezone}>
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Home className="size-4.5" />
            </span>
            <span className="hidden sm:inline">Household</span>
          </Link>
          <div className="ml-2">
            <AppNav variant="top" />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Link
              href="/profile"
              className="mr-1 hidden text-sm text-muted-foreground hover:text-foreground sm:inline"
            >
              {user.name}
            </Link>
            <Tooltip label="Notifications">
              <NotificationBell />
            </Tooltip>
            <Tooltip label="Activity">
              <Link
                href="/activity"
                aria-label="Activity"
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'icon' }),
                  'text-muted-foreground hover:text-foreground',
                )}
              >
                <History />
              </Link>
            </Tooltip>
            <Tooltip label="Profile">
              <Link
                href="/profile"
                aria-label="Profile"
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'icon' }),
                  'text-muted-foreground hover:text-foreground',
                )}
              >
                <UserRound />
              </Link>
            </Tooltip>
            {serverAdmin ? (
              <Tooltip label="Server">
                <Link
                  href="/server"
                  aria-label="Server"
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'icon' }),
                    'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <ServerCog />
                </Link>
              </Tooltip>
            ) : null}
            {can(user.role, 'members:manage') ? (
              <Tooltip label="Household members">
                <Link
                  href="/members"
                  aria-label="Household members"
                  className={cn(
                    buttonVariants({ variant: 'ghost', size: 'icon' }),
                    'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Users />
                </Link>
              </Tooltip>
            ) : null}
            <Tooltip label="Settings">
              <Link
                href="/settings"
                aria-label="Settings"
                className={cn(
                  buttonVariants({ variant: 'ghost', size: 'icon' }),
                  'text-muted-foreground hover:text-foreground',
                )}
              >
                <Settings />
              </Link>
            </Tooltip>
            <Tooltip label="Report a bug">
              <ReportBugButton />
            </Tooltip>
            <Tooltip label="Toggle theme">
              <ThemeToggle />
            </Tooltip>
            <Tooltip label="Sign out">
              <SignOutButton />
            </Tooltip>
          </div>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-6"
      >
        {children}
      </main>

      <AppNav variant="bottom" />
      <KeyboardShortcuts />
      {access && !access.reviewed ? <AccessPrompt settings={access} /> : null}
    </div>
    </HouseholdZoneProvider>
  );
}
