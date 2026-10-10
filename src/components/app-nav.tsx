'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  Calendar,
  History,
  Inbox,
  LayoutDashboard,
  ListChecks,
  MoreHorizontal,
  Receipt,
  ShoppingCart,
  Trophy,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type NavItem = {
  href: string;
  label: string;
  short: string;
  icon: typeof Inbox;
  /** Phone: on the bottom bar itself; the rest sit behind "More". */
  primary?: boolean;
  /** Desktop: only reachable from the account menu (and More on phones). */
  menuOnly?: boolean;
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
  { href: '/activity', label: 'Activity', short: 'Activity', icon: History, menuOnly: true },
];

const topItems = items.filter((i) => !i.menuOnly);
const bottomItems = items.filter((i) => i.primary);
const moreItems = items.filter((i) => !i.primary);

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

/**
 * Desktop: one row of tabs (the account menu holds the rest). Phone: four
 * tabs plus "More", a sheet with the other pages. `requestsWaiting` (requests
 * waiting on the viewer) badges Requests, and More while Requests is inside it.
 */
export function AppNav({
  variant,
  requestsWaiting = 0,
}: {
  variant: 'top' | 'bottom';
  requestsWaiting?: number;
}) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);
  const badgeFor = (href: string) => (href === '/requests' ? requestsWaiting : 0);

  if (variant === 'bottom') return <BottomNav isActive={isActive} badgeFor={badgeFor} />;

  return (
    <nav className="hidden items-center gap-1 md:flex">
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
}: {
  isActive: (href: string) => boolean;
  badgeFor: (href: string) => number;
}) {
  const pathname = usePathname();
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
          className="fixed inset-0 z-10 bg-black/40 md:hidden"
          onClick={() => setMoreOpen(false)}
        />
      ) : null}

      {/* The sheet hangs off the bar's top edge, whatever the bar's height. */}
      <div className="fixed inset-x-0 bottom-0 z-20 md:hidden">
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
            gridTemplateColumns: `repeat(${bottomItems.length + 1}, minmax(0, 1fr))`,
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
            </Link>
          ))}
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
        </nav>
      </div>
    </>
  );
}
