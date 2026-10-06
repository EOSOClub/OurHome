'use client';

import { useId, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Repeat,
  Trash2,
  Users,
} from 'lucide-react';
import type { EventOccurrenceDTO, MemberDTO } from '@/lib/types';
import { apiFetch, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Dialog } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { toast } from '@/components/ui/toast';

type YearMonth = { year: number; month: number };
type Repeat = 'none' | 'daily' | 'weekly' | 'monthly';
type ViewMode = 'month' | 'week' | 'agenda';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_PILLS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function monthRange({ year, month }: YearMonth) {
  return {
    start: new Date(year, month, 1),
    end: new Date(year, month + 1, 0, 23, 59, 59, 999),
  };
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

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
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

function toggleIn(list: number[], value: number): number[] {
  return list.includes(value)
    ? list.filter((d) => d !== value)
    : [...list, value];
}

export function CalendarView({
  initialMonth,
  initialOccurrences,
  members,
  canWrite,
}: {
  initialMonth: YearMonth;
  initialOccurrences: EventOccurrenceDTO[];
  members: MemberDTO[];
  canWrite: boolean;
}) {
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
    return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : dateValue(new Date());
  });
  const [editing, setEditing] = useState<EventOccurrenceDTO | null>(null);
  const [creatingDate, setCreatingDate] = useState<string | null>(null);
  const [viewingDay, setViewingDay] = useState<string | null>(null);

  const isInitial = ym.year === initialMonth.year && ym.month === initialMonth.month;
  const range = monthRange(ym);

  const { data: occurrences = [], isFetching } = useQuery({
    queryKey: ['calendar', ym.year, ym.month],
    queryFn: () =>
      apiFetch<EventOccurrenceDTO[]>(
        `/api/calendar/events?start=${range.start.toISOString()}&end=${range.end.toISOString()}`,
      ),
    initialData: isInitial ? initialOccurrences : undefined,
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
  const weekEnd = new Date(
    weekDays[6].getFullYear(),
    weekDays[6].getMonth(),
    weekDays[6].getDate(),
    23, 59, 59, 999,
  );

  // Week view fetches its own range so a week spanning two months stays complete.
  const { data: weekOccurrences = [], isFetching: isFetchingWeek } = useQuery({
    queryKey: ['calendar', 'week', weekStartKey],
    queryFn: () =>
      apiFetch<EventOccurrenceDTO[]>(
        `/api/calendar/events?start=${weekDays[0].toISOString()}&end=${weekEnd.toISOString()}`,
      ),
    enabled: view === 'week',
    // Keep showing the previous week while the next one refetches.
    placeholderData: keepPreviousData,
  });

  const weekByDay = useMemo(() => {
    const map = new Map<string, EventOccurrenceDTO[]>();
    const sorted = [...weekOccurrences].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );
    for (const o of sorted) {
      const key = dateValue(new Date(o.start));
      const list = map.get(key);
      if (list) list.push(o);
      else map.set(key, [o]);
    }
    return map;
  }, [weekOccurrences]);

  const byDay = useMemo(() => {
    const map = new Map<string, EventOccurrenceDTO[]>();
    for (const o of occurrences) {
      const key = dateValue(new Date(o.start));
      const list = map.get(key);
      if (list) list.push(o);
      else map.set(key, [o]);
    }
    return map;
  }, [occurrences]);

  const matrix = useMemo(() => monthMatrix(ym), [ym]);
  const todayKey = dateValue(new Date());

  // Chronological [dayKey, events] pairs for the agenda list.
  const agendaDays = useMemo(() => {
    const sorted = [...occurrences].sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );
    const map = new Map<string, EventOccurrenceDTO[]>();
    for (const o of sorted) {
      const key = dateValue(new Date(o.start));
      const list = map.get(key);
      if (list) list.push(o);
      else map.set(key, [o]);
    }
    return [...map.entries()];
  }, [occurrences]);

  // Mirror month + view into the URL so the view can be linked/restored.
  // Month view is the default, so it stays out of the query string; the ?d
  // anchor day only applies to (and is only kept for) week view.
  const syncUrl = (nextYm: YearMonth, nextView: ViewMode, nextAnchor: string) => {
    const params = new URLSearchParams();
    params.set('ym', `${nextYm.year}-${pad(nextYm.month + 1)}`);
    if (nextView !== 'month') params.set('view', nextView);
    if (nextView === 'week') params.set('d', nextAnchor);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
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

  const changeView = (next: ViewMode) => {
    let nextAnchor = anchor;
    if (next === 'week') {
      // Re-anchor when the kept anchor left the viewed month: today when the
      // viewed month is the current one, otherwise the 1st of that month.
      const a = new Date(`${anchor}T00:00`);
      if (a.getFullYear() !== ym.year || a.getMonth() !== ym.month) {
        const today = new Date();
        nextAnchor =
          today.getFullYear() === ym.year && today.getMonth() === ym.month
            ? dateValue(today)
            : dateValue(new Date(ym.year, ym.month, 1));
        setAnchor(nextAnchor);
      }
    }
    setView(next);
    syncUrl(ym, next, nextAnchor);
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
    queryClient.invalidateQueries({ queryKey: ['calendar'] });
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
          <Button onClick={() => setCreatingDate(dateValue(new Date()))}>
            <CalendarPlus /> New event
          </Button>
        ) : null}
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">
          {view === 'week'
            ? weekDays[0].getMonth() === weekDays[6].getMonth()
              ? `${MONTHS[weekDays[0].getMonth()]} ${weekDays[0].getDate()} – ${weekDays[6].getDate()}, ${weekDays[6].getFullYear()}`
              : `${MONTHS[weekDays[0].getMonth()]} ${weekDays[0].getDate()} – ${MONTHS[weekDays[6].getMonth()]} ${weekDays[6].getDate()}, ${weekDays[6].getFullYear()}`
            : `${MONTHS[ym.month]} ${ym.year}`}
        </h2>
        <div className="flex items-center gap-1">
          <div
            role="group"
            aria-label="Calendar view"
            className="mr-1 flex rounded-md border border-border p-0.5"
          >
            {(['month', 'week', 'agenda'] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => changeView(v)}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
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
              const d = new Date();
              if (view === 'week') changeAnchor(dateValue(d));
              else changeMonth({ year: d.getFullYear(), month: d.getMonth() });
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
            const events = byDay.get(key) ?? [];
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                aria-label={`${MONTHS[day.getMonth()]} ${day.getDate()}, ${
                  events.length === 1 ? '1 event' : `${events.length} events`
                }`}
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
                  {events.slice(0, 3).map((o, i) => (
                    <button
                      key={`${o.eventId}-${i}`}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(o);
                      }}
                      className="flex w-full items-center gap-1 truncate rounded bg-primary/15 px-1.5 py-0.5 text-left text-xs text-primary hover:bg-primary/25"
                    >
                      {o.recurring ? <Repeat className="size-2.5 shrink-0" /> : null}
                      <span className="truncate">
                        {o.allDay ? '' : `${timeLabel(o.start)} `}
                        {o.title}
                      </span>
                    </button>
                  ))}
                  {events.length > 3 ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setViewingDay(key);
                      }}
                      className="w-full rounded px-1 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    >
                      +{events.length - 3} more
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
            const events = weekByDay.get(key) ?? [];
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
                  aria-label={`${MONTHS[day.getMonth()]} ${day.getDate()}, ${
                    events.length === 1 ? '1 event' : `${events.length} events`
                  }`}
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
                  {events.length === 0 ? (
                    <p className="px-1.5 text-xs text-muted-foreground">—</p>
                  ) : (
                    events.map((o, j) => (
                      <button
                        key={`${o.eventId}-${j}`}
                        type="button"
                        onClick={() => setEditing(o)}
                        className="flex w-full items-center gap-1 truncate rounded bg-primary/15 px-1.5 py-0.5 text-left text-xs text-primary hover:bg-primary/25"
                      >
                        {o.recurring ? (
                          <Repeat className="size-2.5 shrink-0" />
                        ) : null}
                        <span className="truncate">
                          {o.allDay ? '' : `${timeLabel(o.start)} `}
                          {o.title}
                        </span>
                      </button>
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
            No events this month.
          </p>
        ) : (
          agendaDays.map(([key, events]) => {
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
                  {events.map((o, i) => (
                    <button
                      key={`${o.eventId}-${i}`}
                      type="button"
                      onClick={() => setEditing(o)}
                      className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/40"
                    >
                      <span className="w-16 shrink-0 text-xs text-muted-foreground">
                        {o.allDay ? 'All day' : timeLabel(o.start)}
                      </span>
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
          occurrences={byDay.get(viewingDay) ?? []}
          onClose={() => setViewingDay(null)}
          onOpen={setEditing}
        />
      )}

      {(editing || creatingDate) && (
        <EventDialog
          key={editing?.eventId ?? `new-${creatingDate}`}
          occurrence={editing}
          defaultDate={creatingDate}
          members={members}
          canWrite={canWrite}
          onClose={closeDialogs}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function DayDialog({
  dayKey,
  occurrences,
  onClose,
  onOpen,
}: {
  dayKey: string;
  occurrences: EventOccurrenceDTO[];
  onClose: () => void;
  onOpen: (o: EventOccurrenceDTO) => void;
}) {
  const day = new Date(`${dayKey}T00:00`);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${MONTHS[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`}
      description={
        occurrences.length === 1 ? '1 event' : `${occurrences.length} events`
      }
    >
      <div className="space-y-2">
        {occurrences.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events on this day.</p>
        ) : null}
        {occurrences.map((o, i) => (
          <button
            key={`${o.eventId}-${i}`}
            type="button"
            onClick={() => onOpen(o)}
            className="flex w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/40"
          >
            <span className="w-16 shrink-0 text-xs text-muted-foreground">
              {o.allDay ? 'All day' : timeLabel(o.start)}
            </span>
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
        ))}
      </div>
    </Dialog>
  );
}

function EventDialog({
  occurrence,
  defaultDate,
  members,
  canWrite,
  onClose,
  onSaved,
}: {
  occurrence: EventOccurrenceDTO | null;
  defaultDate: string | null;
  members: MemberDTO[];
  canWrite: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editingDisabled = !canWrite;
  const baseStart = occurrence ? new Date(occurrence.baseStart) : null;
  const baseEnd = occurrence?.baseEnd ? new Date(occurrence.baseEnd) : null;

  const [title, setTitle] = useState(occurrence?.title ?? '');
  const [description, setDescription] = useState(occurrence?.description ?? '');
  const [location, setLocation] = useState(occurrence?.location ?? '');
  const [allDay, setAllDay] = useState(occurrence?.allDay ?? false);
  const [startDate, setStartDate] = useState(
    baseStart ? dateValue(baseStart) : (defaultDate ?? dateValue(new Date())),
  );
  const [startTime, setStartTime] = useState(baseStart ? timeValue(baseStart) : '09:00');
  const [endDate, setEndDate] = useState(baseEnd ? dateValue(baseEnd) : '');
  const [endTime, setEndTime] = useState(baseEnd ? timeValue(baseEnd) : '10:00');
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
      ? dateValue(new Date(occurrence.recurrence.until))
      : '',
  );
  const [error, setError] = useState<string | null>(null);

  const formId = useId();

  // Mirrors buildPayload's date assembly so validation matches what is saved.
  const startAt = startDate
    ? new Date(`${startDate}T${allDay ? '00:00' : startTime}`)
    : null;
  const endAt = endDate
    ? new Date(`${endDate}T${allDay ? '23:59' : endTime}`)
    : null;
  const endBeforeStart = Boolean(startAt && endAt && endAt < startAt);
  const canSave = Boolean(title.trim() && startDate && !endBeforeStart);

  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['calendar'] });

  const buildPayload = () => {
    const startAt = new Date(`${startDate}T${allDay ? '00:00' : startTime}`);
    const endAt = endDate
      ? new Date(`${endDate}T${allDay ? '23:59' : endTime}`)
      : null;
    const recurrence =
      repeat === 'none'
        ? occurrence
          ? null
          : undefined
        : {
            kind: repeat,
            interval,
            timezone:
              Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            until: until ? new Date(`${until}T12:00:00`).toISOString() : null,
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
    };
  };

  const save = useMutation({
    mutationFn: () => {
      const payload = buildPayload();
      return occurrence
        ? apiFetch('/api/calendar/events/update', {
            method: 'POST',
            body: JSON.stringify({ id: occurrence.eventId, ...payload }),
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
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Failed to save event'),
  });

  const remove = useMutation({
    mutationFn: () =>
      apiFetch('/api/calendar/events/delete', {
        method: 'POST',
        body: JSON.stringify({ id: occurrence!.eventId }),
      }),
    onSuccess: () => {
      toast.success('Event deleted');
      invalidate();
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
          ? 'Editing applies to the whole repeating series.'
          : undefined
      }
      footer={
        <>
          {occurrence && canWrite ? (
            <Button
              variant="ghost"
              className="mr-auto text-destructive hover:text-destructive"
              disabled={remove.isPending}
              onClick={() => setConfirmDelete(true)}
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
          save.mutate();
        }}
      >
      <fieldset disabled={editingDisabled} className="space-y-4">
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="ev-title">Title</Label>
          <Input
            id="ev-title"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Dentist appointment"
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-input"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
          />
          All day
        </label>
        {allDay ? (
          <p className="text-xs text-muted-foreground">
            Times are set automatically — starts at 00:00
            {endDate ? ' and ends at 23:59' : ''}.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ev-start-date">Starts</Label>
            <Input
              id="ev-start-date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          {!allDay ? (
            <div className="space-y-1.5">
              <Label htmlFor="ev-start-time">Start time</Label>
              <Input
                id="ev-start-time"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="ev-end-date">Ends (optional)</Label>
            <Input
              id="ev-end-date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          {!allDay && endDate ? (
            <div className="space-y-1.5">
              <Label htmlFor="ev-end-time">End time</Label>
              <Input
                id="ev-end-time"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          ) : null}
          {endBeforeStart ? (
            <p className="text-xs text-destructive sm:col-span-2" role="alert">
              End must be on or after the start.
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ev-location" className="flex items-center gap-1.5">
            <MapPin className="size-3.5" /> Location
          </Label>
          <Input
            id="ev-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="optional"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ev-repeat" className="flex items-center gap-1.5">
              <Repeat className="size-3.5" /> Repeats
            </Label>
            <Select
              id="ev-repeat"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value as Repeat)}
            >
              <option value="none">Does not repeat</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </Select>
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
              />
            </div>
          ) : null}
        </div>

        {members.length > 0 ? (
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              <Users className="size-3.5" /> Attendees
            </Label>
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

        <div className="space-y-1.5">
          <Label htmlFor="ev-desc">Notes</Label>
          <Textarea
            id="ev-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="optional"
          />
        </div>
      </fieldset>
      </form>
    </Dialog>

    <ConfirmDialog
      open={confirmDelete}
      onClose={() => setConfirmDelete(false)}
      onConfirm={() => {
        setConfirmDelete(false);
        remove.mutate();
      }}
      title="Delete event"
      description={
        occurrence?.recurring
          ? 'Delete this event? This removes the whole repeating series.'
          : 'Delete this event?'
      }
      confirmLabel="Delete"
      destructive
    />
    </>
  );
}
