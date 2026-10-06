'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Boxes,
  Calendar,
  Inbox,
  LayoutDashboard,
  ListChecks,
  Receipt,
  ShoppingCart,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const items = [
  { href: '/dashboard', label: 'Dashboard', short: 'Home', icon: LayoutDashboard },
  { href: '/tasks', label: 'Tasks', short: 'Tasks', icon: ListChecks },
  { href: '/calendar', label: 'Calendar', short: 'Calendar', icon: Calendar },
  { href: '/shopping', label: 'Shopping', short: 'Shop', icon: ShoppingCart },
  { href: '/inventory', label: 'Inventory', short: 'Stock', icon: Boxes },
  { href: '/bills', label: 'Bills', short: 'Bills', icon: Receipt },
  { href: '/requests', label: 'Requests', short: 'Requests', icon: Inbox },
];

export function AppNav({ variant }: { variant: 'top' | 'bottom' }) {
  const pathname = usePathname();
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  if (variant === 'bottom') {
    return (
      <nav
        className="fixed inset-x-0 bottom-0 z-20 grid border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        style={{
          gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
        }}
      >
        {items.map(({ href, short, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? 'page' : undefined}
            className={cn(
              'flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium',
              isActive(href) ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="size-5" />
            {short}
          </Link>
        ))}
      </nav>
    );
  }

  return (
    <nav className="hidden items-center gap-1 md:flex">
      {items.map(({ href, label, icon: Icon }) => (
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
        </Link>
      ))}
    </nav>
  );
}
