'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bug,
  History,
  Loader2,
  LogOut,
  Moon,
  ServerCog,
  Settings,
  Sun,
  Trophy,
  Users,
} from 'lucide-react';
import type { ProfileColor } from '@/lib/profile';
import { ProfileAvatar } from '@/components/profile/profile-avatar';
import { ReportBugDialog } from '@/components/report-bug-dialog';
import { useSignOut } from '@/components/sign-out-button';
import { useTheme } from '@/components/theme-toggle';
import { cn } from '@/lib/utils';

const itemClass =
  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:bg-accent disabled:opacity-60';

/**
 * The header's avatar button and its menu: everything about "me" and the
 * household's admin pages, so the header only keeps the bell next to it.
 * Members/Server items only appear for those allowed to use them.
 */
export function UserMenu({
  name,
  roleLabel,
  emoji,
  color,
  canManageMembers,
  serverAdmin,
}: {
  name: string;
  roleLabel: string;
  emoji: string | null;
  color: ProfileColor | null;
  canManageMembers: boolean;
  serverAdmin: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [bugOpen, setBugOpen] = React.useState(false);
  const [theme, toggleTheme] = useTheme();
  const { signOut, loading: signingOut } = useSignOut();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const items = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Navigating (a link in the menu, or anywhere else) closes it.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  React.useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'ArrowDown') move(at + 1);
    else if (e.key === 'ArrowUp') move(at - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(list.length - 1);
    else if (e.key === 'Tab') setOpen(false);
  }

  const link = (href: string, label: string, Icon: typeof Users) => (
    <Link href={href} role="menuitem" className={itemClass} onClick={() => setOpen(false)}>
      <Icon className="size-4 text-muted-foreground" />
      {label}
    </Link>
  );

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center rounded-full p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ProfileAvatar name={name} emoji={emoji} color={color} size="sm" />
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Account"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-30 mt-2 w-60 rounded-lg border border-border bg-card p-1 shadow-lg"
        >
          <Link
            href="/profile"
            role="menuitem"
            className={cn(itemClass, 'py-2.5')}
            onClick={() => setOpen(false)}
          >
            <ProfileAvatar name={name} emoji={emoji} color={color} size="sm" />
            <span className="min-w-0">
              <span className="block truncate font-medium">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {roleLabel} · Profile
              </span>
            </span>
          </Link>

          <div role="separator" className="my-1 h-px bg-border" />
          {link('/activity', 'Activity', History)}
          {link('/points', 'Points', Trophy)}

          <div role="separator" className="my-1 h-px bg-border" />
          {canManageMembers ? link('/members', 'Household members', Users) : null}
          {link('/settings', 'Settings', Settings)}
          {serverAdmin ? link('/server', 'Server', ServerCog) : null}

          <div role="separator" className="my-1 h-px bg-border" />
          {/* Stays open so the change is visible; the label names the result. */}
          <button type="button" role="menuitem" className={itemClass} onClick={toggleTheme}>
            {theme === 'dark' ? (
              <Sun className="size-4 text-muted-foreground" />
            ) : (
              <Moon className="size-4 text-muted-foreground" />
            )}
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              setBugOpen(true);
            }}
          >
            <Bug className="size-4 text-muted-foreground" />
            Report a bug
          </button>
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            disabled={signingOut}
            onClick={signOut}
          >
            {signingOut ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <LogOut className="size-4 text-muted-foreground" />
            )}
            Sign out
          </button>
        </div>
      ) : null}

      <ReportBugDialog open={bugOpen} onClose={() => setBugOpen(false)} />
    </div>
  );
}
