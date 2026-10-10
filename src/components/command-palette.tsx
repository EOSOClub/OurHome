'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Banknote,
  Bell,
  Boxes,
  Calendar,
  CalendarPlus,
  Clapperboard,
  Inbox,
  LayoutDashboard,
  ListChecks,
  ListPlus,
  PackagePlus,
  Receipt,
  Search,
  Settings,
  ShoppingCart,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useHrefEnabled } from '@/components/household-features';

/**
 * Command palette — a purpose-built lightweight overlay (Ctrl/⌘+K, opened by
 * KeyboardShortcuts). Follows the Dialog conventions in ui/dialog.tsx
 * (backdrop, scroll lock, Escape, focus restore) but skips its header chrome
 * so the search input sits on top and is focused immediately. Its Escape/Tab
 * handling runs in the capture phase with stopPropagation, so an underlying
 * Dialog's bubble-phase listener never sees the same keystroke — the palette
 * therefore can't fight over Escape with the module-level dialog stack.
 */

interface Command {
  name: string;
  href: string;
  icon: LucideIcon;
  keywords: string[];
  /** Trailing muted hint, e.g. "Go to Bills" for actions that land on a page. */
  hint?: string;
}

const NAVIGATION: Command[] = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, keywords: ['home', 'overview', 'start'] },
  { name: 'Tasks', href: '/tasks', icon: ListChecks, keywords: ['todo', 'chores'] },
  { name: 'Shopping', href: '/shopping', icon: ShoppingCart, keywords: ['groceries', 'list', 'buy'] },
  { name: 'Inventory', href: '/inventory', icon: Boxes, keywords: ['stock', 'pantry', 'supplies'] },
  { name: 'Bills', href: '/bills', icon: Receipt, keywords: ['payments', 'finance', 'money'] },
  { name: 'Calendar', href: '/calendar', icon: Calendar, keywords: ['events', 'schedule', 'agenda'] },
  { name: 'Requests', href: '/requests', icon: Inbox, keywords: ['movies', 'tv', 'shows', 'media', 'ask'] },
  { name: 'Notifications', href: '/notifications', icon: Bell, keywords: ['alerts', 'inbox'] },
  { name: 'Members', href: '/members', icon: Users, keywords: ['household', 'people', 'family'] },
  { name: 'Settings', href: '/settings', icon: Settings, keywords: ['preferences', 'config', 'categories'] },
  { name: 'Profile', href: '/profile', icon: UserRound, keywords: ['account', 'password', 'me'] },
];

// Creation happens on the destination page, so these are "Go to X" actions.
const ACTIONS: Command[] = [
  { name: 'New task', href: '/tasks', icon: ListPlus, keywords: ['create', 'add', 'todo', 'chore'], hint: 'Go to Tasks' },
  { name: 'Add shopping item', href: '/shopping', icon: PackagePlus, keywords: ['create', 'new', 'groceries', 'buy'], hint: 'Go to Shopping' },
  { name: 'Log payment', href: '/bills', icon: Banknote, keywords: ['create', 'add', 'pay', 'bill', 'money'], hint: 'Go to Bills' },
  { name: 'Request a movie or show', href: '/requests', icon: Clapperboard, keywords: ['create', 'add', 'movie', 'tv', 'media'], hint: 'Go to Requests' },
  { name: 'New event', href: '/calendar', icon: CalendarPlus, keywords: ['create', 'add', 'schedule', 'appointment'], hint: 'Go to Calendar' },
];

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // The panel mounts fresh on every open, so query/selection state resets
  // without any effect-driven setState.
  if (!open) return null;
  return <PalettePanel onClose={onClose} />;
}

function PalettePanel({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();
  const hrefEnabled = useHrefEnabled();

  const q = query.trim().toLowerCase();
  const matches = (c: Command) =>
    hrefEnabled(c.href) &&
    (q.length === 0 ||
    c.name.toLowerCase().includes(q) ||
      c.keywords.some((k) => k.includes(q)));

  const groups = [
    { label: 'Navigation', items: NAVIGATION.filter(matches) },
    { label: 'Actions', items: ACTIONS.filter(matches) },
  ].filter((g) => g.items.length > 0);
  const flat = groups.flatMap((g) => g.items);
  const selected = Math.min(selectedIndex, Math.max(flat.length - 1, 0));

  const run = React.useCallback(
    (cmd: Command) => {
      onClose();
      router.push(cmd.href);
    },
    [onClose, router],
  );

  React.useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        // The input is the palette's only focusable control — trap focus on
        // it and keep the keystroke from any dialog underneath.
        e.preventDefault();
        e.stopPropagation();
        inputRef.current?.focus();
      }
    };
    // Capture phase: runs before ui/dialog's bubble-phase listener, so an
    // open Dialog under the palette doesn't also react to Escape/Tab.
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  // Keep the selected row visible while arrowing through a long list.
  React.useEffect(() => {
    document
      .getElementById(`${listId}-option-${selected}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected, query, listId]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length > 0) setSelectedIndex((selected + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length > 0) {
        setSelectedIndex((selected - 1 + flat.length) % flat.length);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = flat[selected];
      if (cmd) run(cmd);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh] sm:pt-[18vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative z-10 w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-lg">
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Type a command or search…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              flat.length > 0 ? `${listId}-option-${selected}` : undefined
            }
            aria-label="Search commands"
            autoComplete="off"
            spellCheck={false}
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {flat.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            No matching commands.
          </p>
        ) : (
          <div
            id={listId}
            role="listbox"
            aria-label="Commands"
            className="max-h-80 overflow-y-auto p-2"
          >
            {groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label}>
                <div
                  aria-hidden="true"
                  className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground"
                >
                  {group.label}
                </div>
                {group.items.map((cmd) => {
                  const index = flat.indexOf(cmd);
                  const isSelected = index === selected;
                  return (
                    <div
                      key={`${cmd.name}-${cmd.href}`}
                      id={`${listId}-option-${index}`}
                      role="option"
                      aria-selected={isSelected}
                      onMouseMove={() => setSelectedIndex(index)}
                      onClick={() => run(cmd)}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm',
                        isSelected && 'bg-accent text-accent-foreground',
                      )}
                    >
                      <cmd.icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate">{cmd.name}</span>
                      {cmd.hint ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {cmd.hint}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
