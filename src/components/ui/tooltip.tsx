'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Minimal tooltip — no external dependency. Wraps its child in an inline
 * wrapper and shows a small label after a short delay on hover or keyboard
 * focus. The child keeps its own accessible name (aria-label); the tooltip is
 * purely visual reinforcement and stays aria-hidden so screen readers don't
 * announce the label twice. Escape dismisses it early.
 */
export function Tooltip({
  label,
  delay = 300,
  className,
  children,
}: {
  label: string;
  /** Delay in ms before the tooltip appears. */
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const show = React.useCallback(() => {
    clearTimer();
    timerRef.current = window.setTimeout(() => setOpen(true), delay);
  }, [clearTimer, delay]);

  const hide = React.useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  React.useEffect(() => clearTimer, [clearTimer]);

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      // Focus/blur bubble through React's delegation, so keyboard focus on the
      // wrapped control triggers these too.
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key === 'Escape') hide();
      }}
    >
      {children}
      {open ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground shadow-md"
        >
          {label}
        </span>
      ) : null}
    </span>
  );
}
