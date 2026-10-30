'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  Calendar,
  HeartHandshake,
  History,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  MoreHorizontal,
  Receipt,
  ShoppingCart,
  Trophy,
} from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { apiFetch } from '@/lib/api';
import { useHrefEnabled } from '@/components/household-features';
import type { NavBadges } from '@/server/services/navBadgeService';

type NavItem = {
  href: string;
  label: string;
  short: string;
  icon: typeof Inbox;
  /** Phone: on the bottom bar itself; the rest sit behind "More". */
  primary?: boolean;
  /** Desktop: only reachable from the account menu (and More on phones). */
  menuOnly?: boolean;
  /** Only for adults who supervise someone. */
  looksAfterOnly?: boolean;
};

const items: NavItem[] = [
  { href: '/dashboard', label: 'Home', short: 'Home', icon: LayoutDashboard, primary: true },
  { href: '/tasks', label: 'Tasks', short: 'Tasks', icon: ListChecks, primary: true },
  { href: '/calendar', label: 'Calendar', short: 'Calendar', icon: Calendar },
  { href: '/shopping', label: 'Shopping', short: 'Shop', icon: ShoppingCart, primary: true },
  { href: '/inventory', label: 'Inventory', short: 'Stock', icon: Boxes, primary: true },
  { href: '/bills', label: 'Bills', short: 'Bills', icon: Receipt },
  { href: '/requests', label: 'Requests', short: 'Requests', icon: Inbox },
  // Desktop has these in the account menu; phones get them under More.
  { href: '/points', label: 'Points', short: 'Points', icon: Trophy, menuOnly: true },
  { href: '/map', label: 'Map', short: 'Map', icon: MapIcon, menuOnly: true },
  { href: '/look-after', label: 'Look after', short: 'Look after', icon: HeartHandshake, menuOnly: true, looksAfterOnly: true },
  { href: '/activity', label: 'Activity', short: 'Activity', icon: History, menuOnly: true },
];

const BOTTOM_TABS = 4;

/**
 * Only the pages this household has on (the server admin can turn features
 * off). On phones, a turned-off tab's slot goes to the next page from More,
 * so the bar stays full; More disappears when nothing is left in it.
 * [looksAfter]: the viewer supervises someone, so "Look after" is shown.
 */
function useNavItems(looksAfter: boolean) {
  const enabled = useHrefEnabled();
  const on = items.filter((i) => enabled(i.href) && (!i.looksAfterOnly || looksAfter));
  const bottom = on.filter((i) => i.primary);
  for (const i of on) {
    if (bottom.length >= BOTTOM_TABS) break;
    if (!i.primary && !i.menuOnly) bottom.push(i);
  }
  bottom.sort((a, b) => items.indexOf(a) - items.indexOf(b));
  return {
    topItems: on.filter((i) => !i.menuOnly),
    bottomItems: bottom,
    moreItems: on.filter((i) => !bottom.includes(i)),
  };
}

function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white',
        className,
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export const NAV_BADGES_KEY = ['nav-badges'] as const;

/**
 * The tab counts, starting from the layout's (which never re-renders on
 * navigation) and asked again on every page change, on focus and each minute.
 */
function useNavBadges(initial: NavBadges, pathname: string) {
  const { data, refetch } = useQuery({
    queryKey: NAV_BADGES_KEY,
    queryFn: () => apiFetch<NavBadges>('/api/badges'),
    initialData: initial,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const firstPath = React.useRef(pathname);
  React.useEffect(() => {
    if (pathname === firstPath.current) return;
    firstPath.current = '';
    void refetch();
  }, [pathname, refetch]);
  // router.refresh() re-renders the layout, handing in a new counts object
  // (even with the same numbers), which initialData ignores after the first
  // render: take it as the latest.
  const queryClient = useQueryClient();
  const firstCounts = React.useRef(initial);
  React.useEffect(() => {
    if (initial === firstCounts.current) return;
    firstCounts.current = initial;
    queryClient.setQueryData<NavBadges>(NAV_BADGES_KEY, initial);
  }, [initial, queryClient]);
  return data;
}

/**
 * Desktop: one row of tabs (the account menu holds the rest). Phone: four
 * tabs plus "More", a sheet with the other pages. `requestsNew` (requests
 * someone else made or changed since the viewer last opened Requests) badges
 * Requests, and More while Requests is inside it; `tasksToCheck` (tasks sent
 * for the viewer's OK) badges Tasks the same way. Requests shows no count while
 * it is open: opening it is what clears it.
 */
export function AppNav({
  variant,
  initialBadges,
  looksAfter = false,
}: {
  variant: 'top' | 'bottom';
  initialBadges: NavBadges;
  /** The viewer supervises someone ("Look after" under More). */
  looksAfter?: boolean;
}) {
  const pathname = usePathname();
  const { topItems } = useNavItems(looksAfter);
  const badges = useNavBadges(initialBadges, pathname);
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const badgeFor = (href: string) =>
    href === '/requests'
      ? isActive(href) ? 0 : badges.requestsNew
      : href === '/tasks' ? badges.tasksToCheck : 0;

  if (variant === 'bottom') return <BottomNav isActive={isActive} badgeFor={badgeFor} looksAfter={looksAfter} />;

  return (
    // The labeled row needs about 750px, so tablets keep the phone bar.
    <nav className="hidden items-center gap-1 lg:flex">
      {topItems.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={isActive(href) ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
            isActive(href)
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
          )}
        >
          <Icon className="size-4" />
          {label}
          <CountBadge count={badgeFor(href)} />
        </Link>
      ))}
    </nav>
  );
}

function BottomNav({
  isActive,
  badgeFor,
  looksAfter,
}: {
  isActive: (href: string) => boolean;
  badgeFor: (href: string) => number;
  looksAfter: boolean;
}) {
  const pathname = usePathname();
  const { bottomItems, moreItems } = useNavItems(looksAfter);
  const [moreOpen, setMoreOpen] = React.useState(false);
  const moreRef = React.useRef<HTMLButtonElement>(null);
  const sheetRef = React.useRef<HTMLDivElement>(null);
  const moreActive = moreItems.some((i) => isActive(i.href));
  const moreBadge = moreItems.reduce((n, i) => n + badgeFor(i.href), 0);

  // Picking a page (or navigating any other way) closes the sheet.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMoreOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!moreOpen) return;
    sheetRef.current?.querySelector<HTMLElement>('a')?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMoreOpen(false);
      moreRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [moreOpen]);

  const tabClass = (active: boolean) =>
    cn(
      'relative flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium',
      active ? 'text-primary' : 'text-muted-foreground',
    );

  return (
    <>
      {moreOpen ? (
        // Tap outside to close; sits under the bar so More still toggles.
        <div
          aria-hidden
          className="fixed inset-0 z-10 bg-black/40 lg:hidden"
          onClick={() => setMoreOpen(false)}
        />
      ) : null}

      {/* The sheet hangs off the bar's top edge, whatever the bar's height. */}
      <div className="fixed inset-x-0 bottom-0 z-20 lg:hidden">
        {moreOpen ? (
          <div
            ref={sheetRef}
            id="more-sheet"
            role="dialog"
            aria-label="More pages"
            className="absolute inset-x-0 bottom-full grid grid-cols-3 gap-1 rounded-t-xl border-t border-border bg-card p-3 shadow-lg"
          >
            {moreItems.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                aria-current={isActive(href) ? 'page' : undefined}
                onClick={() => setMoreOpen(false)}
                className={cn(
                  'relative flex flex-col items-center gap-1 rounded-lg px-2 py-3 text-xs font-medium',
                  isActive(href)
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                )}
              >
                <Icon className="size-5" />
                {label}
                <CountBadge count={badgeFor(href)} className="absolute right-3 top-2" />
              </Link>
            ))}
          </div>
        ) : null}

        <nav
          className="grid border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
          style={{
            gridTemplateColumns: `repeat(${bottomItems.length + (moreItems.length ? 1 : 0)}, minmax(0, 1fr))`,
          }}
        >
          {bottomItems.map(({ href, short, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? 'page' : undefined}
              className={tabClass(isActive(href) && !moreOpen)}
            >
              <Icon className="size-5" />
              {short}
              {/* Tasks is on the bar itself, so its count sits on its tab, placed like More's. */}
              <CountBadge count={badgeFor(href)} className="absolute left-1/2 top-1 ml-1.5" />
            </Link>
          ))}
          {moreItems.length ? (
          <button
            ref={moreRef}
            type="button"
            aria-expanded={moreOpen}
            aria-controls="more-sheet"
            aria-label={moreBadge > 0 ? `More (${moreBadge} waiting on you)` : 'More'}
            onClick={() => setMoreOpen((v) => !v)}
            className={tabClass(moreActive || moreOpen)}
          >
            <MoreHorizontal className="size-5" />
            More
            <CountBadge count={moreBadge} className="absolute left-1/2 top-1 ml-1.5" />
          </button>
          ) : null}
        </nav>
      </div>
    </>
  );
}
