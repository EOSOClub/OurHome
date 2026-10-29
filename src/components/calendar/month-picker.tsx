'use client';

import * as React from 'react';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

type YearMonth = { year: number; month: number };

// The page restores the month from ?ym=YYYY-MM, so years stay four digits.
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

/**
 * The calendar's heading as a button that opens a year and month chooser:
 * arrows step the year, a month jumps there. Arrow keys move around the
 * months; Escape, a click outside or tabbing away closes it.
 */
export function MonthPicker({
  value,
  today,
  onPick,
  children,
}: {
  /** The month on screen: the chooser opens on its year with it selected. */
  value: YearMonth;
  /** The current month in the household's zone, marked in the grid. */
  today: YearMonth;
  onPick: (next: YearMonth) => void;
  /** The heading text shown on the button. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [year, setYear] = React.useState(value.year);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const panelId = React.useId();

  const months = () =>
    Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);

  React.useEffect(() => {
    if (!open) return;
    // The selected month, or January when another year is showing.
    months()[year === value.year ? value.month : 0]?.focus();
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // Focus only when it opens, not on every year step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = () => {
    if (!open) setYear(value.year);
    setOpen((v) => !v);
  };

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const pick = (month: number) => {
    onPick({ year, month });
    close();
  };

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    const list = months();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    list[Math.min(11, Math.max(0, at + step))]?.focus();
  }

  return (
    <div
      ref={rootRef}
      className="relative min-w-0 flex-1"
      // Tabbing past it closes it (clicks outside are the pointer handler's).
      onBlur={(e) => {
        if (e.relatedTarget && !rootRef.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <h2 className="text-lg font-medium">
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={toggle}
          className="-mx-1.5 flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0">{children}</span>
          <ChevronDown
            aria-hidden
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </button>
      </h2>

      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Choose a month"
          onKeyDown={onKeyDown}
          className="absolute left-0 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous year"
              disabled={year <= MIN_YEAR}
              onClick={() => setYear((y) => y - 1)}
            >
              <ChevronLeft />
            </Button>
            <span aria-live="polite" className="text-sm font-semibold tabular-nums">
              {year}
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next year"
              disabled={year >= MAX_YEAR}
              onClick={() => setYear((y) => y + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
          <div ref={gridRef} className="grid grid-cols-3 gap-1">
            {MONTHS.map((name, i) => {
              const selected = year === value.year && i === value.month;
              const current = year === today.year && i === today.month;
              return (
                <button
                  key={name}
                  type="button"
                  aria-label={`${name} ${year}`}
                  aria-current={selected ? 'date' : undefined}
                  onClick={() => pick(i)}
                  className={cn(
                    'rounded-md px-2 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    selected
                      ? 'bg-primary font-medium text-primary-foreground'
                      : 'hover:bg-accent',
                    current && !selected && 'font-semibold text-primary ring-1 ring-inset ring-primary/40',
                  )}
                >
                  {name.slice(0, 3)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
