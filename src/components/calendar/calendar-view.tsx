'use client';

import { useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  BellRing,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Loader2,
  MapPin,
  Repeat,
  Trash2,
  Users,
} from 'lucide-react';
import type { CalendarChoreDTO, EventOccurrenceDTO, MemberDTO } from '@/lib/types';
import { canModify, type PageAccess } from '@/lib/permissions';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FieldNote } from '@/components/ui/field-note';
import { useFieldErrors } from '@/lib/use-field-errors';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';
import { useHouseholdZone } from '@/components/household-zone';
import { dateKey, timeKey, zonedInstant } from '@/lib/format';
import { ALL_DAY_REMINDERS, TIMED_REMINDERS } from '@/lib/validation/calendar';
import { MONTHS, MonthPicker } from '@/components/calendar/month-picker';

type YearMonth = { year: number; month: number };
type Repeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
type Scope = 'this' | 'following' | 'all';
type ViewMode = 'month' | 'week' | 'agenda';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_PILLS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Midnight that starts the day `key` in the household's zone (the page's
// first render uses the same bounds).
const dayStart = (key: string, timeZone?: string) => zonedInstant(key, '00:00', timeZone);

/** [start, end] of the days `first` through `last` in the household's zone. */
function dayRange(first: Date, last: Date, timeZone?: string) {
  const after = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  return {
    start: dayStart(dateValue(first), timeZone),
    end: new Date(dayStart(dateValue(after), timeZone).getTime() - 1),
  };
}

function monthRange({ year, month }: YearMonth, timeZone?: string) {
  return dayRange(new Date(year, month, 1), new Date(year, month + 1, 0), timeZone);
}

function monthMatrix({ year, month }: YearMonth): Date[][] {
  const startDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((startDay + daysInMonth) / 7);
  const rows: Date[][] = [];
  let cur = new Date(year, month, 1 - startDay);
  for (let w = 0; w < weeks; w += 1) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d += 1) {
      row.push(cur);
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
    }
    rows.push(row);
  }
  return rows;
}

// Event times in the household's zone, so the server render and the browser
// agree (see HouseholdZoneProvider).
function timeLabel(iso: string, timeZone?: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

// RecurrenceDTO carries byWeekday/byMonthday as comma-delimited strings.
function parseList(value: string | null | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

const REMINDER_LABELS: Record<'timed' | 'allDay', Record<number, string>> = {
  timed: {
    0: 'At the start',
    15: '15 minutes before',
    30: '30 minutes before',
    60: '1 hour before',
    120: '2 hours before',
    1440: '1 day before',
  },
  allDay: {
    0: 'On the day, 9 AM',
    1440: '1 day before, 9 AM',
    2880: '2 days before, 9 AM',
    10080: '1 week before, 9 AM',
  },
};

function toggleIn(list: number[], value: number): number[] {
  return list.includes(value)
    ? list.filter((d) => d !== value)
    : [...list, value];
}

/** One thing on a day: an event's date, or a chore's due date. */
type Entry =
  | { kind: 'event'; at: string; allDay: boolean; o: EventOccurrenceDTO }
  | { kind: 'chore'; at: string; allDay: boolean; c: CalendarChoreDTO };
type Who = 'everyone' | 'mine';
type Kind = 'events' | 'chores';
/** A range's events and chores, fetched together so they show up together. */
type RangeData = { events: EventOccurrenceDTO[]; chores: CalendarChoreDTO[] };

/** Entries by their day in the household's zone: all-day ones first, then by time. */
function groupByDay(entries: Entry[], timeZone?: string): Map<string, Entry[]> {
  const sorted = [...entries].sort(
    (a, b) =>
      Number(a.allDay === false) - Number(b.allDay === false) ||
      new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
  const map = new Map<string, Entry[]>();
  for (const e of sorted) {
    // The day in the household zone (same on server and browser).
    const key = dateKey(e.at, timeZone);
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  }
  return map;
}

/** "2 events", "1 event, 1 chore", "No events". */
function countLabel(entries: Entry[]): string {
  const events = entries.filter((e) => e.kind === 'event').length;
  const chores = entries.length - events;
  const parts = [
    events || !chores ? `${events} event${events === 1 ? '' : 's'}` : null,
    chores ? `${chores} chore${chores === 1 ? '' : 's'}` : null,
  ];
  return parts.filter(Boolean).join(', ');
}

export function CalendarView({
  initialMonth,
  initialOccurrences,
  initialChores,
  choresOn,
  members,
  access,
  userId,
}: {
  initialMonth: YearMonth;
  initialOccurrences: EventOccurrenceDTO[];
  /** The first month's chores, rendered with the events. */
  initialChores: CalendarChoreDTO[];
  /** Tasks is on for the household, so chores can show. */
  choresOn: boolean;
  members: MemberDTO[];
  /** The viewer's Calendar access (Members → Permissions). */
  access: PageAccess;
  userId: string;
}) {
  const timeZone = useHouseholdZone();
  // Clicking a day / "New event" creates, so it follows the Add permission.
  const canWrite = access.create;
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [ym, setYm] = useState<YearMonth>(initialMonth);
  const [view, setView] = useState<ViewMode>(() => {
    const v = searchParams.get('view');
    return v === 'agenda' || v === 'week' ? v : 'month';
  });
  // Anchor day for week view (?d=YYYY-MM-DD); defaults to today.
  const [anchor, setAnchor] = useState<string>(() => {
    const d = searchParams.get('d');
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : dateKey(new Date(), timeZone);
  });
  // Filters (?who=mine, ?hide=chores): whose things, and which kinds, show.
  const [who, setWho] = useState<Who>(() =>
    searchParams.get('who') === 'mine' ? 'mine' : 'everyone',
  );
  const [hidden, setHidden] = useState<Set<Kind>>(
    () =>
      new Set(
        (searchParams.get('hide') ?? '')
          .split(',')
          .filter((k): k is Kind => k === 'events' || k === 'chores'),
      ),
  );
  const [editing, setEditing] = useState<EventOccurrenceDTO | null>(null);
  const [creatingDate, setCreatingDate] = useState<string | null>(null);
  const [viewingDay, setViewingDay] = useState<string | null>(null);

  const isInitial = ym.year === initialMonth.year && ym.month === initialMonth.month;
  const range = monthRange(ym, timeZone);

  const fetchRange = async (start: Date, end: Date): Promise<RangeData> => {
    const qs = `start=${start.toISOString()}&end=${end.toISOString()}`;
    const [events, chores] = await Promise.all([
      apiFetch<EventOccurrenceDTO[]>(`/api/calendar/events?${qs}`),
      choresOn ? apiFetch<CalendarChoreDTO[]>(`/api/calendar/items?${qs}`) : [],
    ]);
    return { events, chores };
  };

  const {
    data: { events: occurrences, chores } = { events: [], chores: [] },
    isFetching,
  } = useQuery({
    queryKey: ['calendar', ym.year, ym.month],
    queryFn: () => fetchRange(range.start, range.end),
    initialData: isInitial ? { events: initialOccurrences, chores: initialChores } : undefined,
    // Keep showing the previous month's grid while the next one refetches.
    placeholderData: keepPreviousData,
  });

  // Sunday-first week containing the anchor day.
  const weekDays = useMemo(() => {
    const a = new Date(`${anchor}T00:00`);
    const start = new Date(a.getFullYear(), a.getMonth(), a.getDate() - a.getDay());
    return Array.from(
      { length: 7 },
      (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    );
  }, [anchor]);

  const weekStartKey = dateValue(weekDays[0]);
  const weekRange = dayRange(weekDays[0], weekDays[6], timeZone);

  // Week view fetches its own range, so a week spanning two months stays complete.
  const {
    data: { events: weekOccurrences, chores: weekChores } = { events: [], chores: [] },
    isFetching: isFetchingWeek,
  } = useQuery({
    queryKey: ['calendar', 'week', weekStartKey],
    queryFn: () => fetchRange(weekRange.start, weekRange.end),
    enabled: view === 'week',
    // Keep showing the previous week while the next one refetches.
    placeholderData: keepPreviousData,
  });

  // What the filters let through, as day entries.
  const toEntries = (events: EventOccurrenceDTO[], choreList: CalendarChoreDTO[]): Entry[] => [
    ...(hidden.has('events') ? [] : events)
      .filter(
        (o) =>
          who === 'everyone' ||
          o.createdById === userId ||
          o.attendees.some((a) => a.id === userId),
      )
      .map((o): Entry => ({ kind: 'event', at: o.start, allDay: o.allDay, o })),
    ...(hidden.has('chores') || !choresOn ? [] : choreList)
      .filter((c) => who === 'everyone' || c.assigneeId === userId)
      .map((c): Entry => ({ kind: 'chore', at: c.due, allDay: c.allDay, c })),
  ];

  const weekByDay = groupByDay(toEntries(weekOccurrences, weekChores), timeZone);
  const byDay = groupByDay(toEntries(occurrences, chores), timeZone);

  const matrix = useMemo(() => monthMatrix(ym), [ym]);
  const todayKey = dateKey(new Date(), timeZone);
  const todayYm = {
    year: Number(todayKey.slice(0, 4)),
    month: Number(todayKey.slice(5, 7)) - 1,
  };

  // Chronological [dayKey, entries] pairs for the agenda list.
  const agendaDays = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Mirror month + view (and the filters) into the URL so the view can be
  // linked/restored. Month view and no filters are the default, so they stay
  // out of the query string; the ?d anchor day only applies to (and is only
  // kept for) week view.
  const syncUrl = (
    nextYm: YearMonth,
    nextView: ViewMode,
    nextAnchor: string,
    nextWho: Who = who,
    nextHidden: Set<Kind> = hidden,
  ) => {
    const params = new URLSearchParams();
    params.set('ym', `${nextYm.year}-${pad(nextYm.month + 1)}`);
    if (nextView !== 'month') params.set('view', nextView);
    if (nextView === 'week') params.set('d', nextAnchor);
    if (nextWho === 'mine') params.set('who', 'mine');
    if (nextHidden.size) params.set('hide', [...nextHidden].sort().join(','));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const changeWho = (next: Who) => {
    setWho(next);
    syncUrl(ym, view, anchor, next);
  };

  const toggleKind = (kind: Kind) => {
    const next = new Set(hidden);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    setHidden(next);
    syncUrl(ym, view, anchor, who, next);
  };

  const changeMonth = (next: YearMonth) => {
    setYm(next);
    syncUrl(next, view, anchor);
  };

  // Week navigation moves the anchor day; ym follows it so the month/agenda
  // views (and their query) stay pointed at the anchor's month.
  const changeAnchor = (nextAnchor: string) => {
    const d = new Date(`${nextAnchor}T00:00`);
    const nextYm = { year: d.getFullYear(), month: d.getMonth() };
    setAnchor(nextAnchor);
    setYm(nextYm);
    syncUrl(nextYm, view, nextAnchor);
  };

  // The week to show for a month: today's when it is the current month,
  // otherwise the one with the 1st.
  const anchorIn = (target: YearMonth) => {
    const today = dateKey(new Date(), timeZone);
    return today.startsWith(`${target.year}-${pad(target.month + 1)}-`)
      ? today
      : dateValue(new Date(target.year, target.month, 1));
  };

  const changeView = (next: ViewMode) => {
    let nextAnchor = anchor;
    if (next === 'week') {
      // Re-anchor when the kept anchor left the viewed month.
      const a = new Date(`${anchor}T00:00`);
      if (a.getFullYear() !== ym.year || a.getMonth() !== ym.month) {
        nextAnchor = anchorIn(ym);
        setAnchor(nextAnchor);
      }
    }
    setView(next);
    syncUrl(ym, next, nextAnchor);
  };

  // The heading's month chooser: week view jumps to a week in that month.
  const jumpTo = (target: YearMonth) => {
    if (view === 'week') changeAnchor(anchorIn(target));
    else changeMonth(target);
  };

  const shift = (delta: number) => {
    if (view === 'week') {
      const a = new Date(`${anchor}T00:00`);
      changeAnchor(
        dateValue(new Date(a.getFullYear(), a.getMonth(), a.getDate() + delta * 7)),
      );
      return;
    }
    const d = new Date(ym.year, ym.month + delta, 1);
    changeMonth({ year: d.getFullYear(), month: d.getMonth() });
  };

  const closeDialogs = () => {
    setEditing(null);
    setCreatingDate(null);
  };
  const onSaved = () => {
    void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    closeDialogs();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Calendar</h1>
          <p className="text-sm text-muted-foreground">
            Shared household events and appointments.
          </p>
        </div>
        {canWrite ? (
          <Button onClick={() => setCreatingDate(dateKey(new Date(), timeZone))}>
            <CalendarPlus /> New event
          </Button>
        ) : null}
      </div>

      {/* Phones: the toolbar box dissolves (`contents`) so the view switcher
          can drop to its own full-width row under the title and arrows. */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-3">
        <MonthPicker value={ym} today={todayYm} onPick={jumpTo}>
          {view === 'week'
            ? weekDays[0].getMonth() === weekDays[6].getMonth()
              ? `${MONTHS[weekDays[0].getMonth()]} ${weekDays[0].getDate()} - ${weekDays[6].getDate()}, ${weekDays[6].getFullYear()}`
              : `${MONTHS[weekDays[0].getMonth()]} ${weekDays[0].getDate()} - ${MONTHS[weekDays[6].getMonth()]} ${weekDays[6].getDate()}, ${weekDays[6].getFullYear()}`
            : `${MONTHS[ym.month]} ${ym.year}`}
        </MonthPicker>
        <div className="contents sm:flex sm:items-center sm:gap-1">
          <div
            role="group"
            aria-label="Calendar view"
            className="order-last flex basis-full rounded-md border border-border p-0.5 sm:order-none sm:mr-1 sm:basis-auto"
          >
            {(['month', 'week', 'agenda'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => changeView(v)}
                className={`flex-1 rounded px-2.5 py-1 text-xs font-medium transition-colors sm:flex-none ${
                  view === v
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {v === 'month' ? 'Month' : v === 'week' ? 'Week' : 'Agenda'}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Today in the household's zone, like the highlighted day.
              const today = dateKey(new Date(), timeZone);
              if (view === 'week') changeAnchor(today);
              else {
                const [y, m] = today.split('-').map(Number);
                changeMonth({ year: y, month: m - 1 });
              }
            }}
          >
            Today
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={view === 'week' ? 'Previous week' : 'Previous month'}
            onClick={() => shift(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={view === 'week' ? 'Next week' : 'Next month'}
            onClick={() => shift(1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Whose"
          className="flex rounded-md border border-border p-0.5"
        >
          {(['everyone', 'mine'] as const).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={who === w}
              onClick={() => changeWho(w)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                who === w
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {w === 'everyone' ? 'Everyone' : 'Mine'}
            </button>
          ))}
        </div>
        {choresOn ? (
          <div role="group" aria-label="Show" className="flex gap-1">
            {(['events', 'chores'] as const).map((k) => {
              const shown = !hidden.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={shown}
                  onClick={() => toggleKind(k)}
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                    shown
                      ? 'border-border text-foreground'
                      : 'border-dashed border-border text-muted-foreground'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`size-2 rounded-full ${
                      k === 'events' ? 'bg-primary' : 'bg-success'
                    } ${shown ? '' : 'opacity-40'}`}
                  />
                  {k === 'events' ? 'Events' : 'Chores'}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {view === 'month' ? (
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="grid grid-cols-7 border-b border-border bg-muted/40">
          {WEEKDAYS.map((d) => (
            <div
              key={d}
              className="px-2 py-1.5 text-center text-xs font-medium text-muted-foreground"
            >
              {d}
            </div>
          ))}
        </div>
        <div
          className={`grid grid-cols-7 transition-opacity ${
            isFetching ? 'opacity-60' : ''
          }`}
        >
          {matrix.flat().map((day) => {
            const key = dateValue(day);
            const inMonth = day.getMonth() === ym.month;
            const entries = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                aria-label={`${MONTHS[day.getMonth()]} ${day.getDate()}, ${countLabel(entries)}`}
                className={`min-h-24 border-b border-r border-border p-1.5 last:border-r-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  inMonth ? '' : 'bg-muted/30'
                } ${canWrite ? 'cursor-pointer hover:bg-accent/40' : ''}`}
                onClick={() => canWrite && setCreatingDate(key)}
                onKeyDown={(e) => {
                  // Ignore keys bubbling up from the event/overflow buttons.
                  if (e.target !== e.currentTarget) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (canWrite) setCreatingDate(key);
                  }
                }}
              >
                <div className="mb-1 flex justify-end">
                  <span
                    className={`flex size-6 items-center justify-center rounded-full text-xs ${
                      key === todayKey
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : inMonth
                          ? 'text-foreground'
                          : 'text-muted-foreground'
                    }`}
                  >
                    {day.getDate()}
                  </span>
                </div>
                <div className="space-y-1">
                  {entries.slice(0, 3).map((entry, i) => (
                    <EntryChip
                      key={entryKey(entry, i)}
                      entry={entry}
                      onOpen={setEditing}
                    />
                  ))}
                  {entries.length > 3 ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setViewingDay(key);
                      }}
                      className="w-full rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    >
                      +{entries.length - 3} more
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      ) : view === 'week' ? (
      <div className="overflow-hidden rounded-lg border border-border">
        <div
          className={`grid grid-cols-1 sm:grid-cols-7 transition-opacity ${
            isFetchingWeek ? 'opacity-60' : ''
          }`}
        >
          {weekDays.map((day, i) => {
            const key = dateValue(day);
            const entries = weekByDay.get(key) ?? [];
            return (
              <div
                key={key}
                className={`sm:min-h-40 ${
                  i < 6 ? 'border-b border-border sm:border-b-0 sm:border-r' : ''
                }`}
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-label={`${MONTHS[day.getMonth()]} ${day.getDate()}, ${countLabel(entries)}`}
                  className={`flex items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:flex-col sm:gap-0.5 ${
                    canWrite ? 'cursor-pointer hover:bg-accent/40' : ''
                  }`}
                  onClick={() => canWrite && setCreatingDate(key)}
                  onKeyDown={(e) => {
                    // Ignore keys bubbling up from the event buttons.
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (canWrite) setCreatingDate(key);
                    }
                  }}
                >
                  <span className="text-xs font-medium text-muted-foreground">
                    {WEEKDAYS[day.getDay()]}
                  </span>
                  <span
                    className={`flex size-6 items-center justify-center rounded-full text-xs ${
                      key === todayKey
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : 'text-foreground'
                    }`}
                  >
                    {day.getDate()}
                  </span>
                </div>
                <div className="space-y-1 p-1.5">
                  {entries.length === 0 ? (
                    <p className="px-1.5 text-xs text-muted-foreground">-</p>
                  ) : (
                    entries.map((entry, j) => (
                      <EntryChip
                        key={entryKey(entry, j)}
                        entry={entry}
                        onOpen={setEditing}
                      />
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      ) : (
      <div
        className={`space-y-4 transition-opacity ${isFetching ? 'opacity-60' : ''}`}
      >
        {agendaDays.length === 0 ? (
          <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground">
            {choresOn && !hidden.has('chores')
              ? 'No events or chores this month.'
              : 'No events this month.'}
          </p>
        ) : (
          agendaDays.map(([key, entries]) => {
            const day = new Date(`${key}T00:00`);
            return (
              <section key={key} className="space-y-1.5">
                <h3
                  className={`text-sm font-medium ${
                    key === todayKey ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {WEEKDAYS[day.getDay()]} · {MONTHS[day.getMonth()]}{' '}
                  {day.getDate()}
                  {key === todayKey ? ' · Today' : ''}
                </h3>
                <div className="space-y-1.5">
                  {entries.map((entry, i) => (
                    <EntryRow
                      key={entryKey(entry, i)}
                      entry={entry}
                      onOpen={setEditing}
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>
      )}

      {viewingDay && (
        <DayDialog
          dayKey={viewingDay}
          entries={byDay.get(viewingDay) ?? []}
          onClose={() => setViewingDay(null)}
          onOpen={setEditing}
        />
      )}

      {(editing || creatingDate) && (
        <EventDialog
          key={editing ? `${editing.eventId}-${editing.start}` : `new-${creatingDate}`}
          occurrence={editing}
          defaultDate={creatingDate}
          members={members}
          access={access}
          userId={userId}
          onClose={closeDialogs}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

const entryKey = (entry: Entry, i: number) =>
  entry.kind === 'event' ? `${entry.o.eventId}-${i}` : `chore-${entry.c.id}`;

const choreHref = (c: CalendarChoreDTO) => `/tasks?task=${encodeURIComponent(c.id)}`;

/** A compact entry in a month cell or week column. Events open the event; chores open the task. */
function EntryChip({
  entry,
  onOpen,
}: {
  entry: Entry;
  onOpen: (o: EventOccurrenceDTO) => void;
}) {
  const timeZone = useHouseholdZone();
  const time = entry.allDay ? '' : `${timeLabel(entry.at, timeZone)} `;
  if (entry.kind === 'chore') {
    const { c } = entry;
    return (
      <Link
        href={choreHref(c)}
        // The day cell behind it would start a new event.
        onClick={(e) => e.stopPropagation()}
        title={c.overdue ? `${c.title} (overdue)` : c.title}
        className={`flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-left text-xs ${
          c.overdue
            ? 'bg-destructive/10 text-destructive hover:bg-destructive/20'
            : 'bg-success/15 text-foreground hover:bg-success/25'
        }`}
      >
        <ListChecks
          className={`size-2.5 shrink-0 ${c.overdue ? '' : 'text-success'}`}
          aria-label="Chore"
        />
        <span className="truncate">
          {time}
          {c.title}
        </span>
      </Link>
    );
  }
  const { o } = entry;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(o);
      }}
      className="flex w-full items-center gap-1 truncate rounded bg-primary/15 px-1.5 py-0.5 text-left text-xs text-primary hover:bg-primary/25"
    >
      {o.recurring ? <Repeat className="size-2.5 shrink-0" /> : null}
      <span className="truncate">
        {time}
        {o.title}
      </span>
    </button>
  );
}

/** A full-width entry in the agenda list and the day dialog. */
function EntryRow({
  entry,
  onOpen,
}: {
  entry: Entry;
  onOpen: (o: EventOccurrenceDTO) => void;
}) {
  const timeZone = useHouseholdZone();
  const when = (
    <span className="w-16 shrink-0 text-xs text-muted-foreground">
      {entry.allDay ? 'All day' : timeLabel(entry.at, timeZone)}
    </span>
  );
  const rowClass =
    'flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/40';
  if (entry.kind === 'chore') {
    const { c } = entry;
    return (
      <Link href={choreHref(c)} className={rowClass}>
        {when}
        <ListChecks
          className={`size-3 shrink-0 ${c.overdue ? 'text-destructive' : 'text-success'}`}
          aria-label="Chore"
        />
        <span className="truncate">{c.title}</span>
        {c.overdue ? (
          <span className="shrink-0 text-xs text-destructive">Overdue</span>
        ) : null}
        {c.assigneeName ? (
          <span className="ml-auto flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Users className="size-3 shrink-0" />
            <span className="truncate">{c.assigneeName}</span>
          </span>
        ) : null}
      </Link>
    );
  }
  const { o } = entry;
  return (
    <button type="button" onClick={() => onOpen(o)} className={rowClass}>
      {when}
      {o.recurring ? (
        <Repeat className="size-3 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="truncate">{o.title}</span>
      {o.location ? (
        <span className="ml-auto flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="size-3 shrink-0" />
          <span className="truncate">{o.location}</span>
        </span>
      ) : null}
    </button>
  );
}

function DayDialog({
  dayKey,
  entries,
  onClose,
  onOpen,
}: {
  dayKey: string;
  entries: Entry[];
  onClose: () => void;
  onOpen: (o: EventOccurrenceDTO) => void;
}) {
  const day = new Date(`${dayKey}T00:00`);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${MONTHS[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`}
      description={countLabel(entries)}
    >
      <div className="space-y-2">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events on this day.</p>
        ) : null}
        {entries.map((entry, i) => (
          <EntryRow key={entryKey(entry, i)} entry={entry} onOpen={onOpen} />
        ))}
      </div>
    </Dialog>
  );
}

function EventDialog({
  occurrence,
  defaultDate,
  members,
  access,
  userId,
  onClose,
  onSaved,
}: {
  occurrence: EventOccurrenceDTO | null;
  defaultDate: string | null;
  members: MemberDTO[];
  access: PageAccess;
  userId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  // A new event needs Add; an existing one is edited/deleted by own vs. others'.
  const canWrite = occurrence
    ? canModify(access, 'edit', occurrence.createdById, userId)
    : access.create;
  const canDelete =
    !!occurrence && canModify(access, 'delete', occurrence.createdById, userId);
  const editingDisabled = !canWrite;
  // Dates and times in the household's zone, the same one the grid shows.
  const timeZone = useHouseholdZone();
  // The date that was opened (for a repeating event, the one clicked).
  const baseStart = occurrence ? new Date(occurrence.start) : null;
  const baseEnd = occurrence?.end ? new Date(occurrence.end) : null;

  const [title, setTitle] = useState(occurrence?.title ?? '');
  const [description, setDescription] = useState(occurrence?.description ?? '');
  const [location, setLocation] = useState(occurrence?.location ?? '');
  const [allDay, setAllDay] = useState(occurrence?.allDay ?? false);
  const [startDate, setStartDate] = useState(
    baseStart ? dateKey(baseStart, timeZone) : (defaultDate ?? dateKey(new Date(), timeZone)),
  );
  const [startTime, setStartTime] = useState(baseStart ? timeKey(baseStart, timeZone) : '09:00');
  const [endDate, setEndDate] = useState(baseEnd ? dateKey(baseEnd, timeZone) : '');
  const [endTime, setEndTime] = useState(baseEnd ? timeKey(baseEnd, timeZone) : '10:00');
  const [attendees, setAttendees] = useState<Set<string>>(
    new Set(occurrence?.attendees.map((a) => a.id) ?? []),
  );
  const [repeat, setRepeat] = useState<Repeat>(
    (occurrence?.recurrence?.kind as Repeat) ?? 'none',
  );
  const [interval, setInterval] = useState(occurrence?.recurrence?.interval ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(
    parseList(occurrence?.recurrence?.byWeekday),
  );
  const [monthdays, setMonthdays] = useState<number[]>(
    parseList(occurrence?.recurrence?.byMonthday),
  );
  const [until, setUntil] = useState(
    occurrence?.recurrence?.until
      ? dateKey(occurrence.recurrence.until, timeZone)
      : '',
  );
  // Minutes before, as the select's value; '' = no reminder.
  const [reminder, setReminder] = useState(
    occurrence?.reminderMinutes != null ? String(occurrence.reminderMinutes) : '',
  );
  const reminderChoices: readonly number[] = allDay ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
  const [error, setError] = useState<string | null>(null);

  const formId = useId();

  // Mirrors buildPayload's date assembly so validation matches what is saved.
  const startAt = startDate
    ? zonedInstant(startDate, allDay ? '00:00' : startTime, timeZone)
    : null;
  const endAt = endDate
    ? zonedInstant(endDate, allDay ? '23:59' : endTime, timeZone)
    : null;
  const endBeforeStart = Boolean(startAt && endAt && endAt < startAt);
  const canSave = Boolean(title.trim() && startDate && !endBeforeStart);

  // For the "which dates?" choice on a repeating event: a new repeat can't
  // apply to one date, and a moved time or new repeat resets the dates that
  // were changed one at a time.
  const listKey = (l: number[]) => [...l].sort((a, b) => a - b).join(',');
  const orig = occurrence?.recurrence;
  const repeatEdited =
    !!occurrence &&
    (repeat !== ((orig?.kind as Repeat | undefined) ?? 'none') ||
      (repeat !== 'none' &&
        (interval !== (orig?.interval ?? 1) ||
          (repeat === 'weekly' && listKey(weekdays) !== listKey(parseList(orig?.byWeekday))) ||
          (repeat === 'monthly' && listKey(monthdays) !== listKey(parseList(orig?.byMonthday))))));
  const timeEdited =
    !!occurrence &&
    (allDay !== occurrence.allDay ||
      startAt?.getTime() !== new Date(occurrence.start).getTime());
  const [scopeFor, setScopeFor] = useState<'save' | 'delete' | null>(null);
  // Which date of the series was opened (a changed date answers for its series).
  const scopeFields = (scope: Scope | undefined) =>
    occurrence && scope
      ? { scope, occurrenceStart: occurrence.originalStart ?? occurrence.start }
      : {};

  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['calendar'] });

  const buildPayload = () => {
    const startAt = zonedInstant(startDate, allDay ? '00:00' : startTime, timeZone);
    const endAt = endDate
      ? zonedInstant(endDate, allDay ? '23:59' : endTime, timeZone)
      : null;
    const recurrence =
      repeat === 'none'
        ? occurrence
          ? null
          : undefined
        : {
            kind: repeat,
            interval,
            // Stored for reference; the server repeats events in the
            // household's zone.
            timezone:
              timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            until: until ? zonedInstant(until, '12:00', timeZone).toISOString() : null,
            ...(repeat === 'weekly' && weekdays.length > 0
              ? { byWeekday: weekdays }
              : {}),
            ...(repeat === 'monthly' && monthdays.length > 0
              ? { byMonthday: monthdays }
              : {}),
          };
    return {
      title: title.trim(),
      description: description.trim() || null,
      location: location.trim() || null,
      startAt: startAt.toISOString(),
      endAt: endAt ? endAt.toISOString() : null,
      allDay,
      attendeeIds: [...attendees],
      recurrence,
      reminderMinutes: reminder === '' ? null : Number(reminder),
    };
  };

  // Which fields the server named; the reason is said in the alert at the top.
  const fe = useFieldErrors('ev');

  const save = useMutation({
    mutationFn: (scope?: Scope) => {
      const payload = buildPayload();
      return occurrence
        ? apiFetch('/api/calendar/events/update', {
            method: 'POST',
            body: JSON.stringify({ id: occurrence.eventId, ...scopeFields(scope), ...payload }),
          })
        : apiFetch('/api/calendar/events', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
    },
    onSuccess: () => {
      toast.success(occurrence ? 'Event updated' : 'Event created');
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Failed to save event');
      fe.mark(err);
    },
  });

  const remove = useMutation({
    mutationFn: (scope?: Scope) =>
      apiFetch('/api/calendar/events/delete', {
        method: 'POST',
        body: JSON.stringify({ id: occurrence!.eventId, ...scopeFields(scope) }),
      }),
    onSuccess: () => {
      toast.success('Event deleted');
      void invalidate();
      onSaved();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Failed to delete'),
  });

  const [confirmDelete, setConfirmDelete] = useState(false);

  const toggleAttendee = (id: string) =>
    setAttendees((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <>
    <Dialog
      open
      onClose={onClose}
      title={occurrence ? 'Event' : 'New event'}
      description={
        occurrence?.recurring
          ? 'This event repeats. When you save or delete, you pick which dates it applies to.'
          : undefined
      }
      footer={
        <>
          {canDelete ? (
            <Button
              variant="ghost"
              className="mr-auto text-destructive hover:text-destructive"
              disabled={remove.isPending}
              onClick={() =>
                occurrence?.recurring ? setScopeFor('delete') : setConfirmDelete(true)
              }
            >
              {remove.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
              Delete
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {canWrite ? (
            <Button
              type="submit"
              form={formId}
              disabled={save.isPending || !canSave}
            >
              {save.isPending ? <Loader2 className="animate-spin" /> : null}
              Save
            </Button>
          ) : null}
        </>
      }
    >
      {/* Footer Save lives outside this form; it targets it via form={formId}. */}
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canWrite || save.isPending || !canSave) return;
          if (occurrence?.recurring) setScopeFor('save');
          else save.mutate(undefined);
        }}
        {...fe.formProps}
      >
      <fieldset disabled={editingDisabled} className="space-y-4">
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="space-y-1.5" data-field="title">
          <Label htmlFor="ev-title">Title</Label>
          <Input
            id="ev-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Dentist appointment"
            {...fe.invalid('title')}
          />
          <FieldNote id={fe.noteId('title')} error={fe.get('title')} />
        </div>

        <label className="flex items-center gap-2 text-sm" data-field="allDay">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={allDay}
            onChange={(e) => {
              setAllDay(e.target.checked);
              // Keep the reminder when the other kind offers it too.
              const choices: readonly number[] = e.target.checked ? ALL_DAY_REMINDERS : TIMED_REMINDERS;
              if (reminder && !choices.includes(Number(reminder))) setReminder('');
            }}
          />
          All day
        </label>
        <FieldNote id={fe.noteId('allDay')} error={fe.get('allDay')} />
        {allDay ? (
          <p className="text-xs text-muted-foreground">
            Times are set automatically - starts at 00:00
            {endDate ? ' and ends at 23:59' : ''}.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5" data-field="startAt">
            <Label htmlFor="ev-start-date">Starts</Label>
            <Input
              id="ev-start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              {...fe.invalid('startAt')}
            />
            <FieldNote id={fe.noteId('startAt')} error={fe.get('startAt')} />
          </div>
          {!allDay ? (
            <div className="space-y-1.5" data-field="startAt">
              <Label htmlFor="ev-start-time">Start time</Label>
              <Input
                id="ev-start-time"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                {...fe.invalid('startAt')}
              />
            </div>
          ) : null}
          <div className="space-y-1.5" data-field="endAt">
            <Label htmlFor="ev-end-date">Ends (optional)</Label>
            <Input
              id="ev-end-date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              {...fe.invalid('endAt')}
            />
            <FieldNote id={fe.noteId('endAt')} error={fe.get('endAt')} />
          </div>
          {!allDay && endDate ? (
            <div className="space-y-1.5" data-field="endAt">
              <Label htmlFor="ev-end-time">End time</Label>
              <Input
                id="ev-end-time"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                {...fe.invalid('endAt')}
              />
            </div>
          ) : null}
          {endBeforeStart ? (
            <p className="text-xs text-destructive sm:col-span-2" role="alert">
              End must be on or after the start.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5" data-field="location">
          <Label htmlFor="ev-location" className="flex items-center gap-1.5">
            <MapPin className="size-3.5" /> Location
          </Label>
          <Input
            id="ev-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="optional"
            {...fe.invalid('location')}
          />
          <FieldNote id={fe.noteId('location')} error={fe.get('location')} />
        </div>

        <div className="space-y-1.5" data-field="reminderMinutes">
          <Label htmlFor="ev-reminder" className="flex items-center gap-1.5">
            <BellRing className="size-3.5" /> Remind
          </Label>
          <Select
            id="ev-reminder"
            value={reminder}
            onChange={(e) => setReminder(e.target.value)}
            {...fe.invalid('reminderMinutes')}
          >
            <option value="">No reminder</option>
            {reminderChoices.map((m) => (
              <option key={m} value={String(m)}>
                {REMINDER_LABELS[allDay ? 'allDay' : 'timed'][m]}
              </option>
            ))}
          </Select>
          <FieldNote
            id={fe.noteId('reminderMinutes')}
            error={fe.get('reminderMinutes')}
            hint={
              reminder
                ? 'Goes to the attendees and whoever made the event. It can arrive up to 15 minutes late.'
                : undefined
            }
          />
        </div>

        {/* Every repeat field comes back as "recurrence"; editing any of them clears it. */}
        <div className="grid gap-3 sm:grid-cols-2" data-field="recurrence">
          <div className="space-y-1.5">
            <Label htmlFor="ev-repeat" className="flex items-center gap-1.5">
              <Repeat className="size-3.5" /> Repeats
            </Label>
            <Select
              id="ev-repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as Repeat)}
              {...fe.invalid('recurrence')}
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </Select>
            <FieldNote id={fe.noteId('recurrence')} error={fe.get('recurrence')} />
          </div>
          {repeat !== 'none' ? (
            <div className="space-y-1.5">
              <Label htmlFor="ev-interval">Every</Label>
              <Input
                id="ev-interval"
                type="number"
                min={1}
                max={365}
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value) || 1)}
                {...fe.invalid('recurrence')}
              />
            </div>
          ) : null}
          {repeat === 'weekly' ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>On days (optional)</Label>
              <div className="flex flex-wrap items-center gap-1.5">
                {WEEKDAY_PILLS.map((label, day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setWeekdays((p) => toggleIn(p, day))}
                    className={`size-9 rounded-md border text-sm font-medium transition-colors ${
                      weekdays.includes(day)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input hover:bg-accent'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {repeat === 'monthly' ? (
            <div className="space-y-1.5 sm:col-span-2">
              <Label>On days of month (optional)</Label>
              <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-10">
                {Array.from({ length: 31 }, (_, i) => i + 1).map((day) => (
                  <button
                    key={day}
                    type="button"
                    onClick={() => setMonthdays((p) => toggleIn(p, day))}
                    className={`size-8 rounded-md border text-xs font-medium transition-colors ${
                      monthdays.includes(day)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-input hover:bg-accent'
                    }`}
                  >
                    {day}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {repeat !== 'none' ? (
            <div className="space-y-1.5">
              <Label htmlFor="ev-until">Ends on (optional)</Label>
              <Input
                id="ev-until"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
                {...fe.invalid('recurrence')}
              />
            </div>
          ) : null}
        </div>

        {members.length > 0 ? (
          <div className="space-y-1.5" data-field="attendeeIds">
            <Label className="flex items-center gap-1.5">
              <Users className="size-3.5" /> Attendees
            </Label>
            <FieldNote id={fe.noteId('attendeeIds')} error={fe.get('attendeeIds')} />
            <div className="flex flex-wrap gap-2">
              {members.map((m) => {
                const on = attendees.has(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleAttendee(m.id)}
                    className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                      on
                        ? 'border-transparent bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5" data-field="description">
          <Label htmlFor="ev-desc">Notes</Label>
          <Textarea
            id="ev-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="optional"
            {...fe.invalid('description')}
          />
          <FieldNote id={fe.noteId('description')} error={fe.get('description')} />
        </div>
      </fieldset>
      </form>
    </Dialog>

    <ConfirmDialog
      open={confirmDelete}
      onClose={() => setConfirmDelete(false)}
      onConfirm={() => {
        setConfirmDelete(false);
        remove.mutate(undefined);
      }}
      title="Delete event"
      description="Delete this event?"
      confirmLabel="Delete"
      destructive
    />

    {scopeFor ? (
      <ScopeDialog
        mode={scopeFor}
        // A new repeat can't apply to a single date.
        thisDisabled={scopeFor === 'save' && repeatEdited}
        resetsChanges={scopeFor === 'save' && (timeEdited || repeatEdited)}
        onClose={() => setScopeFor(null)}
        onPick={(scope) => {
          setScopeFor(null);
          if (scopeFor === 'save') save.mutate(scope);
          else remove.mutate(scope);
        }}
      />
    ) : null}
    </>
  );
}

const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: 'this', label: 'This event' },
  { value: 'following', label: 'This and following events' },
  { value: 'all', label: 'All events' },
];

/** "Which dates?" for saving or deleting one date of a repeating event. */
function ScopeDialog({
  mode,
  thisDisabled,
  resetsChanges,
  onClose,
  onPick,
}: {
  mode: 'save' | 'delete';
  thisDisabled: boolean;
  /** The edit moves the time or changes the repeat. */
  resetsChanges: boolean;
  onClose: () => void;
  onPick: (scope: Scope) => void;
}) {
  const [scope, setScope] = useState<Scope>(thisDisabled ? 'following' : 'this');
  const name = useId();
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'save' ? 'Save repeating event' : 'Delete repeating event'}
      description={
        mode === 'save'
          ? 'Which dates should the change apply to?'
          : 'Which dates should be deleted?'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={mode === 'delete' ? 'destructive' : 'default'}
            onClick={() => onPick(scope)}
          >
            {mode === 'save' ? 'Save' : 'Delete'}
          </Button>
        </>
      }
    >
      <div role="radiogroup" className="space-y-2">
        {SCOPE_OPTIONS.map((o) => {
          const disabled = o.value === 'this' && thisDisabled;
          return (
            <label
              key={o.value}
              className={`flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm ${
                disabled ? 'opacity-50' : 'cursor-pointer hover:bg-accent/40'
              }`}
            >
              <input
                type="radio"
                name={name}
                className="mt-0.5 size-4"
                value={o.value}
                checked={scope === o.value}
                disabled={disabled}
                onChange={() => setScope(o.value)}
              />
              <span>
                {o.label}
                {disabled ? (
                  <span className="block text-xs text-muted-foreground">
                    A new repeat can only apply to this and later dates.
                  </span>
                ) : null}
                {o.value !== 'this' && resetsChanges ? (
                  <span className="block text-xs text-muted-foreground">
                    Dates you changed one at a time
                    {o.value === 'following' ? ' from here on' : ''} go back to
                    following the series.
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}
