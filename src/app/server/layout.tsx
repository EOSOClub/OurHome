import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Home, ServerCog } from 'lucide-react';
import { getServerSession, type AuthUser } from '@/server/auth/session';
import { getPointsSettings } from '@/server/services/pointsService';
import { isServerAdmin } from '@/server/services/serverAdminService';
import { HouseholdZoneProvider } from '@/components/household-zone';
import { SignOutButton } from '@/components/sign-out-button';
import { ThemeToggle } from '@/components/theme-toggle';
import { buttonVariants } from '@/components/ui/button';

// The server admin's area. Outside the household pages because a server admin
// needn't belong to a household (a dedicated admin account); one who does
// gets a link back to it.
export default async function ServerLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  if (!session?.user) redirect('/login');
  const user = session.user as unknown as AuthUser;
  if (!(await isServerAdmin(user.id))) redirect('/dashboard');
  // Dates in the admin's household zone, or UTC without one.
  const timezone = user.householdId ? (await getPointsSettings(user.householdId)).timezone : 'UTC';

  return (
    <HouseholdZoneProvider timeZone={timezone}>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-20 border-b border-border bg-card/90 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4">
            <span className="flex items-center gap-2 font-semibold">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <ServerCog className="size-4.5" />
              </span>
              Server
            </span>
            <div className="ml-auto flex items-center gap-1">
              <span className="mr-1 hidden text-sm text-muted-foreground sm:inline">{user.name}</span>
              {user.householdId ? (
                <Link href="/dashboard" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                  <Home /> My household
                </Link>
              ) : null}
              <ThemeToggle />
              <SignOutButton />
            </div>
          </div>
        </header>
        <main id="main-content" className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
          {children}
        </main>
      </div>
    </HouseholdZoneProvider>
  );
}
