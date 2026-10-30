'use client';

import {
  Bell,
  Cake,
  CalendarDays,
  CreditCard,
  Heart,
  Receipt,
  Stethoscope,
  type LucideIcon,
} from 'lucide-react';
import type { EventKind } from '@/lib/enums';
import type { EventOccurrenceDTO } from '@/lib/types';
import { dateKey } from '@/lib/format';
import { cn } from '@/lib/utils';

/** What "New" on the calendar can make: an event of a kind, or a bill. */
export type NewKind = 'event' | 'appointment' | 'birthday' | 'reminder' | 'bill' | 'subscription';

const PICKER: { kind: NewKind; label: string; icon: LucideIcon }[] = [
  { kind: 'event', label: 'Event', icon: CalendarDays },
  { kind: 'appointment', label: 'Appointment', icon: Stethoscope },
  { kind: 'birthday', label: 'Birthday', icon: Cake },
  { kind: 'reminder', label: 'Reminder', icon: Bell },
  { kind: 'bill', label: 'Bill', icon: Receipt },
  { kind: 'subscription', label: 'Subscription', icon: CreditCard },
];

/** The icon for an event's kind; null for a plain event. */
export const KIND_ICONS: Partial<Record<EventKind, LucideIcon>> = {
  appointment: Stethoscope,
  birthday: Cake,
  anniversary: Heart,
  reminder: Bell,
  bill: Receipt,
  subscription: CreditCard,
};

/** The dialog's title for an event of this kind. */
export const KIND_LABELS: Record<EventKind, string> = {
  event: 'Event',
  appointment: 'Appointment',
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  reminder: 'Reminder',
  bill: 'Bill',
  subscription: 'Subscription',
};

/** The picker's choice for an event's kind (an anniversary is under Birthday). */
export const pickerKind = (kind: EventKind): NewKind =>
  kind === 'anniversary' ? 'birthday' : (kind as NewKind);

/**
 * The row of types at the top of a new item's dialog. Bill and Subscription
 * only show when `bills` is on (Bills on for the household, and Add access).
 */
export function TypePicker({
  value,
  bills,
  onPick,
}: {
  value: NewKind;
  bills: boolean;
  onPick: (kind: NewKind) => void;
}) {
  const choices = PICKER.filter((c) => bills || (c.kind !== 'bill' && c.kind !== 'subscription'));
  return (
    <div role="radiogroup" aria-label="What to add" className="grid grid-cols-3 gap-1.5">
      {choices.map(({ kind, label, icon: Icon }) => {
        const on = value === kind;
        return (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(kind)}
            className={cn(
              'flex flex-col items-center gap-1 rounded-md border px-2 py-2 text-xs font-medium transition-colors',
              on
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}

const SUFFIX = { birthday: "'s birthday", anniversary: "'s anniversary" } as const;

/** "Jordan" -> "Jordan's birthday". */
export const yearlyTitle = (whose: string, kind: 'birthday' | 'anniversary') =>
  `${whose.trim()}${SUFFIX[kind]}`;

/** The name back out of a title made by yearlyTitle; null when it was typed another way. */
export function whoseOf(title: string, kind: 'birthday' | 'anniversary'): string | null {
  return title.endsWith(SUFFIX[kind]) ? title.slice(0, -SUFFIX[kind].length) : null;
}

/**
 * An entry's title as shown: a birthday with its year gets the age it turns
 * on that date, an anniversary how many years ("Jordan's birthday (12)").
 */
export function entryTitle(o: EventOccurrenceDTO, timeZone?: string): string {
  if ((o.kind !== 'birthday' && o.kind !== 'anniversary') || o.sinceYear == null) return o.title;
  const years = Number(dateKey(o.start, timeZone).slice(0, 4)) - o.sinceYear;
  if (years <= 0) return o.title;
  return o.kind === 'birthday'
    ? `${o.title} (${years})`
    : `${o.title} (${years} year${years === 1 ? '' : 's'})`;
}
