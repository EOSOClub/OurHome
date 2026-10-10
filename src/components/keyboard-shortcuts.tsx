'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from '@/components/ui/dialog';
import { CommandPalette } from '@/components/command-palette';

/**
 * Global keyboard shortcuts, mounted once in the app layout. `g` followed by a
 * second key (within 1.5s) jumps to a section; `?` opens a sheet listing the
 * bindings; Ctrl/⌘+K toggles the command palette (this one works even while
 * typing in a field). Other keys are ignored while typing in a form control,
 * while any dialog is open, or when a modifier is held.
 */

const CHORD_TIMEOUT_MS = 1500;

const navShortcuts = [
  { key: 'd', href: '/dashboard', label: 'Dashboard' },
  { key: 't', href: '/tasks', label: 'Tasks' },
  { key: 's', href: '/shopping', label: 'Shopping' },
  { key: 'i', href: '/inventory', label: 'Inventory' },
  { key: 'b', href: '/bills', label: 'Bills' },
  { key: 'c', href: '/calendar', label: 'Calendar' },
  { key: 'r', href: '/requests', label: 'Requests' },
  { key: 'p', href: '/points', label: 'Points' },
  { key: 'a', href: '/activity', label: 'Activity' },
  { key: 'n', href: '/notifications', label: 'Notifications' },
] as const;

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-border bg-muted px-1.5 font-mono text-xs text-foreground">
      {children}
    </kbd>
  );
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const pendingChord = React.useRef(false);
  const chordTimer = React.useRef<number | null>(null);

  React.useEffect(() => {
    const clearChord = () => {
      pendingChord.current = false;
      if (chordTimer.current !== null) {
        window.clearTimeout(chordTimer.current);
        chordTimer.current = null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Ctrl/⌘+K toggles the command palette. Checked before every guard so
      // it works while typing in a field, and preventDefault keeps the
      // browser's own search from firing. Closing the help sheet first means
      // the palette and the sheet can never fight over Escape.
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.key.toLowerCase() === 'k'
      ) {
        e.preventDefault();
        setHelpOpen(false);
        setPaletteOpen((prev) => !prev);
        clearChord();
        return;
      }

      // Never intercept browser/OS combos, typing, or keys meant for an open
      // dialog (which covers the shortcuts sheet and the palette — the
      // palette's overlay sets role="dialog").
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"]')) {
        clearChord();
        return;
      }

      if (pendingChord.current) {
        const key = e.key.toLowerCase();
        const match = e.shiftKey
          ? undefined
          : navShortcuts.find((s) => s.key === key);
        clearChord();
        if (match) {
          e.preventDefault();
          router.push(match.href);
        }
        return;
      }

      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (e.shiftKey) return;

      if (e.key === 'g') {
        pendingChord.current = true;
        chordTimer.current = window.setTimeout(clearChord, CHORD_TIMEOUT_MS);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearChord();
    };
  }, [router]);

  return (
    <>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
      <Dialog
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        title="Keyboard shortcuts"
        description="These work anywhere in the app, except while typing in a field."
      >
        <ul className="space-y-1">
          {navShortcuts.map(({ key, label }) => (
            <li
              key={key}
              className="flex items-center justify-between gap-3 py-1.5"
            >
              <span className="text-sm">Go to {label}</span>
              <span className="flex items-center gap-1">
                <Key>g</Key>
                <span className="text-xs text-muted-foreground">then</span>
                <Key>{key}</Key>
              </span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-3 border-t border-border py-1.5 pt-3">
            <span className="text-sm">Command palette</span>
            <span className="flex items-center gap-1">
              <Key>Ctrl/⌘</Key>
              <Key>K</Key>
            </span>
          </li>
          <li className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-sm">Show this sheet</span>
            <Key>?</Key>
          </li>
        </ul>
      </Dialog>
    </>
  );
}
