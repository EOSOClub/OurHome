import type * as React from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Home } from 'lucide-react';
import { requireUser } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { getAccessSettings } from '@/server/services/accessService';
import { getHouseholdFeatures, isServerAdmin } from '@/server/services/serverAdminService';
import { HouseholdFeaturesProvider } from '@/components/household-features';
import { getNavBadges } from '@/server/services/navBadgeService';
import { unseenChangelog } from '@/lib/changelog';
import { AccessPrompt } from '@/components/settings/access-settings';
import { WhatsNew } from '@/components/whats-new';
import { can } from '@/lib/permissions';
import { USER_ROLE_LABELS, type UserRole } from '@/lib/enums';
import { isProfileColor } from '@/lib/profile';
import { AppNav } from '@/components/app-nav';
import { KeyboardShortcuts } from '@/components/keyboard-shortcuts';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { UserMenu } from '@/components/user-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { getPointsSettings } from '@/server/services/pointsService';
import { supervisedIds } from '@/server/services/supervisionService';
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
  // The avatar and what's-new state aren't on the session.
  const [profile, features, supervised] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { avatarEmoji: true, profileColor: true, changelogSeen: true, createdAt: true },
    }),
    getHouseholdFeatures(user.householdId!),
    // "People you look after" is only linked for someone who supervises somebody.
    supervisedIds(user.householdId!, user.id),
  ]);
  const looksAfter = supervised.size > 0;
  // The nav's first counts; it asks again as they move around (AppNav).
  const badges = await getNavBadges({ id: user.id, householdId: user.householdId! });
  const changelog = unseenChangelog(profile?.changelogSeen ?? null, profile?.createdAt ?? new Date());

  // The skip link's #main-content is the <main> further down; the IDE doesn't
  // find ids in JSX.
  // noinspection HtmlUnknownAnchorTarget
  return (
    <HouseholdZoneProvider timeZone={timezone}>
    <HouseholdFeaturesProvider features={features}>
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-20 border-b border-border bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Home className="size-4.5" />
            </span>
            <span className="hidden sm:inline">Household</span>
          </Link>
          <div className="ml-2">
            <AppNav variant="top" initialBadges={badges} looksAfter={looksAfter} />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip label="Notifications">
              <NotificationBell />
            </Tooltip>
            <UserMenu
              name={user.name}
              roleLabel={USER_ROLE_LABELS[user.role as UserRole] ?? user.role}
              emoji={profile?.avatarEmoji ?? null}
              color={isProfileColor(profile?.profileColor) ? profile.profileColor : null}
              canManageMembers={can(user.role, 'members:manage')}
              serverAdmin={serverAdmin}
              looksAfter={looksAfter}
            />
          </div>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 pb-[calc(6rem+env(safe-area-inset-bottom))] lg:pb-6"
      >
        {children}
      </main>

      <AppNav variant="bottom" initialBadges={badges} looksAfter={looksAfter} />
      <KeyboardShortcuts />
      {access && !access.reviewed ? <AccessPrompt settings={access} /> : null}
      {/* After the access question, so the server admin isn't asked two things at once. */}
      {changelog.length > 0 && !(access && !access.reviewed) ? <WhatsNew entries={changelog} /> : null}
    </div>
    </HouseholdFeaturesProvider>
    </HouseholdZoneProvider>
  );
}
