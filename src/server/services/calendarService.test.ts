import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small in-memory stand-in for the Prisma calls calendarService makes, so
// the scope rules (this / following / all) are checked against real rows.
type Row = Record<string, unknown> & { id: string };
const db = { event: [] as Row[], rule: [] as Row[], attendee: [] as Row[] };
let seq = 0;
const nextId = (p: string) => `${p}${++seq}`;

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; gte?: Date };
      if (c.in) return c.in.includes(v);
      if (c.gte) return v instanceof Date && v >= c.gte;
      return false;
    }
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    return v === cond;
  });
}

function withRelations(e: Row) {
  return {
    ...e,
    recurrence: db.rule.find((r) => r.id === e.recurrenceId) ?? null,
    attendees: db.attendee
      .filter((a) => a.eventId === e.id)
      .map((a) => ({ ...a, user: { id: a.userId, name: `User ${a.userId}` } })),
  };
}

function applyData(row: Row, data: Record<string, unknown>) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const op = v as { push?: Date; set?: Date[] };
      if ('push' in op) row[k] = [...((row[k] as Date[]) ?? []), op.push];
      else if ('set' in op) row[k] = op.set;
      continue;
    }
    row[k] = v;
  }
}

const EVENT_DEFAULTS = {
  description: null,
  location: null,
  endAt: null,
  allDay: false,
  recurrenceId: null,
  excludedStarts: [],
  seriesId: null,
  originalStart: null,
  reminderMinutes: null,
  createdById: null,
};

const prisma = {
  event: {
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      db.event.filter((e) => matches(e, where)).map(withRelations),
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const e = db.event.find((x) => matches(x, where));
      return e ? withRelations(e) : null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const { attendees, ...rest } = data as { attendees?: { create: { userId: string }[] } };
      const row: Row = { ...EVENT_DEFAULTS, id: nextId('ev'), ...rest };
      db.event.push(row);
      for (const a of attendees?.create ?? []) {
        db.attendee.push({ id: nextId('at'), eventId: row.id, userId: a.userId });
      }
      return withRelations(row);
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = db.event.find((e) => e.id === where.id)!;
      applyData(row, data);
      return withRelations(row);
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const rows = db.event.filter((e) => matches(e, where));
      rows.forEach((r) => applyData(r, data));
      return { count: rows.length };
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      db.event = db.event.filter((e) => e.id !== where.id);
      db.attendee = db.attendee.filter((a) => a.eventId !== where.id);
    }),
    deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const gone = new Set(db.event.filter((e) => matches(e, where)).map((e) => e.id));
      db.event = db.event.filter((e) => !gone.has(e.id));
      db.attendee = db.attendee.filter((a) => !gone.has(a.eventId as string));
      return { count: gone.size };
    }),
  },
  recurrenceRule: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: Row = { id: nextId('rr'), ...data };
      db.rule.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = db.rule.find((r) => r.id === where.id)!;
      applyData(row, data);
      return row;
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      db.rule = db.rule.filter((r) => r.id !== where.id);
    }),
  },
  eventAttendee: {
    deleteMany: vi.fn(async ({ where }: { where: { eventId: string } }) => {
      db.attendee = db.attendee.filter((a) => a.eventId !== where.eventId);
    }),
    createMany: vi.fn(async ({ data }: { data: { eventId: string; userId: string }[] }) => {
      for (const a of data) db.attendee.push({ id: nextId('at'), ...a });
    }),
  },
  user: {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id.startsWith('u')).map((id) => ({ id })),
    ),
  },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/services/pointsService', () => ({
  getPointsSettings: vi.fn(async () => ({ timezone: 'UTC' })),
}));

const { createEvent, deleteEvent, expandEvent, isOccurrence, listOccurrences, repeatChanged, updateEvent } =
  await import('./calendarService');

const HH = 'hh1';
const at = (s: string) => new Date(s);
const MON = at('2026-11-02T15:00:00.000Z'); // a Monday, 15:00
const week = (n: number) => new Date(MON.getTime() + n * 7 * 86_400_000);
const NOV = { start: at('2026-11-01T00:00:00Z'), end: at('2026-11-30T23:59:59Z') };

/** A weekly series every Monday at 15:00 for an hour, created by u1. */
async function weeklySeries(extra: Record<string, unknown> = {}) {
  const dto = await createEvent(HH, 'u1', {
    title: 'Piano',
    startAt: MON,
    endAt: new Date(MON.getTime() + 3_600_000),
    allDay: false,
    attendeeIds: ['u2'],
    recurrence: { kind: 'weekly', interval: 1, timezone: 'UTC' },
    ...extra,
  });
  return dto.eventId;
}

const starts = async () => (await listOccurrences(HH, NOV.start, NOV.end)).map((o) => [o.start, o.title]);

beforeEach(() => {
  db.event = [];
  db.rule = [];
  db.attendee = [];
  seq = 0;
});

describe('expandEvent', () => {
  const rule = {
    kind: 'daily' as const,
    interval: 1,
    anchorDate: at('2026-11-01T09:00:00Z'),
  };
  const e = { startAt: at('2026-11-01T09:00:00Z'), endAt: null };

  it('lists a series’ dates in the range', () => {
    const out = expandEvent(e, rule, at('2026-11-01T00:00:00Z'), at('2026-11-03T23:59:59Z'));
    expect(out.map((d) => d.toISOString())).toEqual([
      '2026-11-01T09:00:00.000Z',
      '2026-11-02T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
    ]);
  });

  it('skips the dates left out of the series', () => {
    const out = expandEvent(
      { ...e, excludedStarts: [at('2026-11-02T09:00:00Z')] },
      rule,
      at('2026-11-01T00:00:00Z'),
      at('2026-11-03T23:59:59Z'),
    );
    expect(out.map((d) => d.toISOString())).toEqual(['2026-11-01T09:00:00.000Z', '2026-11-03T09:00:00.000Z']);
  });

  it('lists a one-off event that overlaps the range', () => {
    const one = { startAt: at('2026-10-31T22:00:00Z'), endAt: at('2026-11-01T02:00:00Z') };
    expect(expandEvent(one, null, at('2026-11-01T00:00:00Z'), at('2026-11-02T00:00:00Z'))).toHaveLength(1);
    expect(expandEvent(one, null, at('2026-11-02T00:00:00Z'), at('2026-11-03T00:00:00Z'))).toHaveLength(0);
  });

  it('isOccurrence knows real, off-pattern and skipped dates', () => {
    expect(isOccurrence(rule, [], at('2026-11-05T09:00:00Z'))).toBe(true);
    expect(isOccurrence(rule, [], at('2026-11-05T10:00:00Z'))).toBe(false);
    expect(isOccurrence(rule, [at('2026-11-05T09:00:00Z')], at('2026-11-05T09:00:00Z'))).toBe(false);
  });

  it('repeatChanged ignores the end date but not the pattern', () => {
    const stored = { kind: 'weekly', interval: 1, byWeekday: '1', byMonthday: null } as never;
    expect(repeatChanged(stored, { kind: 'weekly', interval: 1, byWeekday: [1], timezone: 'UTC', until: at('2027-01-01T00:00:00Z') })).toBe(false);
    expect(repeatChanged(stored, { kind: 'weekly', interval: 2, byWeekday: [1], timezone: 'UTC' })).toBe(true);
    expect(repeatChanged(stored, { kind: 'weekly', interval: 1, byWeekday: [1, 3], timezone: 'UTC' })).toBe(true);
  });
});

describe('editing one date ("This event")', () => {
  it('moves only that date and keeps the rest of the series', async () => {
    const id = await weeklySeries();
    const moved = at('2026-11-09T17:00:00.000Z');
    await updateEvent(HH, 'u3', {
      id,
      scope: 'this',
      occurrenceStart: week(1),
      title: 'Piano (moved)',
      startAt: moved,
      endAt: new Date(moved.getTime() + 3_600_000),
    });
    expect(await starts()).toEqual([
      ['2026-11-02T15:00:00.000Z', 'Piano'],
      ['2026-11-09T17:00:00.000Z', 'Piano (moved)'],
      ['2026-11-16T15:00:00.000Z', 'Piano'],
      ['2026-11-23T15:00:00.000Z', 'Piano'],
      ['2026-11-30T15:00:00.000Z', 'Piano'],
    ]);
    const override = db.event.find((e) => e.seriesId === id)!;
    // Owned by the series' creator, with the series' attendees.
    expect(override.createdById).toBe('u1');
    expect(db.attendee.filter((a) => a.eventId === override.id).map((a) => a.userId)).toEqual(['u2']);
    // Listed with its series' repeat, so it offers the same choices.
    const listed = (await listOccurrences(HH, NOV.start, NOV.end)).find((o) => o.eventId === override.id)!;
    expect(listed.recurring).toBe(true);
    expect(listed.seriesId).toBe(id);
    expect(listed.originalStart).toBe(week(1).toISOString());
  });

  it('edits the changed date again in place', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(1), title: 'A' });
    const override = db.event.find((e) => e.seriesId === id)!;
    await updateEvent(HH, 'u1', { id: override.id, scope: 'this', title: 'B' });
    expect(db.event.filter((e) => e.seriesId === id)).toHaveLength(1);
    expect((await starts())[1]).toEqual(['2026-11-09T15:00:00.000Z', 'B']);
  });

  it('refuses a date that is not in the series', async () => {
    const id = await weeklySeries();
    await expect(
      updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: at('2026-11-10T15:00:00Z'), title: 'x' }),
    ).rejects.toThrow(/isn’t part of this repeating event/);
  });
});

describe('editing "This and following"', () => {
  it('ends the series before the date and starts a new one there', async () => {
    const id = await weeklySeries();
    const later = new Date(week(2).getTime() + 3_600_000); // 16:00 from the third Monday
    await updateEvent(HH, 'u1', {
      id,
      scope: 'following',
      occurrenceStart: week(2),
      startAt: later,
      endAt: new Date(later.getTime() + 3_600_000),
      recurrence: { kind: 'weekly', interval: 1, timezone: 'UTC' },
    });
    expect((await starts()).map(([s]) => s)).toEqual([
      '2026-11-02T15:00:00.000Z',
      '2026-11-09T15:00:00.000Z',
      '2026-11-16T16:00:00.000Z',
      '2026-11-23T16:00:00.000Z',
      '2026-11-30T16:00:00.000Z',
    ]);
    expect(db.event).toHaveLength(2);
  });

  it('carries later single-date changes over when the time stays', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(3), title: 'Recital' });
    await updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(4), title: 'x' });
    await deleteEvent(HH, 'u1', { id: db.event.find((e) => e.title === 'x')!.id, scope: 'this' });
    await updateEvent(HH, 'u1', {
      id,
      scope: 'following',
      occurrenceStart: week(2),
      title: 'Piano 2',
      startAt: week(2),
      endAt: new Date(week(2).getTime() + 3_600_000),
      recurrence: { kind: 'weekly', interval: 1, timezone: 'UTC' },
    });
    expect(await starts()).toEqual([
      ['2026-11-02T15:00:00.000Z', 'Piano'],
      ['2026-11-09T15:00:00.000Z', 'Piano'],
      ['2026-11-16T15:00:00.000Z', 'Piano 2'],
      ['2026-11-23T15:00:00.000Z', 'Recital'],
    ]);
    const newSeries = db.event.find((e) => e.title === 'Piano 2')!;
    expect(db.event.find((e) => e.title === 'Recital')!.seriesId).toBe(newSeries.id);
  });

  it('drops later single-date changes when the time moves', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(3), title: 'Recital' });
    const later = new Date(week(2).getTime() + 3_600_000);
    await updateEvent(HH, 'u1', {
      id,
      scope: 'following',
      occurrenceStart: week(2),
      startAt: later,
      recurrence: { kind: 'weekly', interval: 1, timezone: 'UTC' },
    });
    expect(db.event.find((e) => e.title === 'Recital')).toBeUndefined();
    expect((await starts()).map(([s]) => s).slice(2)).toEqual([
      '2026-11-16T16:00:00.000Z',
      '2026-11-23T16:00:00.000Z',
      '2026-11-30T16:00:00.000Z',
    ]);
  });

  it('from the first date is the whole series', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'following', occurrenceStart: MON, title: 'Renamed' });
    expect(db.event).toHaveLength(1);
    expect((await starts()).every(([, t]) => t === 'Renamed')).toBe(true);
  });
});

describe('editing "All events"', () => {
  it('moves the whole series by as much as the opened date moved', async () => {
    const id = await weeklySeries();
    const opened = week(2);
    const later = new Date(opened.getTime() + 2 * 3_600_000);
    await updateEvent(HH, 'u1', {
      id,
      scope: 'all',
      occurrenceStart: opened,
      startAt: later,
      endAt: new Date(later.getTime() + 3_600_000),
      recurrence: { kind: 'weekly', interval: 1, timezone: 'UTC' },
    });
    expect((await starts()).map(([s]) => s)[0]).toBe('2026-11-02T17:00:00.000Z');
    expect(db.event[0].startAt).toEqual(at('2026-11-02T17:00:00.000Z'));
  });

  it('keeps single-date changes on a text-only edit, drops them on a time change', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(1), title: 'Special' });
    const rule = { kind: 'weekly' as const, interval: 1, timezone: 'UTC' };
    await updateEvent(HH, 'u1', { id, scope: 'all', occurrenceStart: MON, startAt: MON, title: 'Piano!', recurrence: rule });
    expect(db.event.find((e) => e.title === 'Special')).toBeDefined();

    const moved = new Date(MON.getTime() + 3_600_000);
    await updateEvent(HH, 'u1', { id, scope: 'all', occurrenceStart: MON, startAt: moved, recurrence: rule });
    expect(db.event.find((e) => e.title === 'Special')).toBeUndefined();
    expect(db.event[0].excludedStarts).toEqual([]);
    expect(await starts()).toHaveLength(5);
  });

  it('still works for callers that send no scope (old clients)', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'all', title: 'Plain' });
    expect((await starts()).every(([, t]) => t === 'Plain')).toBe(true);
  });
});

describe('deleting', () => {
  it('"This event" leaves one date out', async () => {
    const id = await weeklySeries();
    await deleteEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(1) });
    expect((await starts()).map(([s]) => s)).not.toContain(week(1).toISOString());
    expect(await starts()).toHaveLength(4);
  });

  it('"This event" on a changed date removes it and keeps it out of the series', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(1), title: 'Special' });
    const override = db.event.find((e) => e.seriesId === id)!;
    await deleteEvent(HH, 'u1', { id: override.id, scope: 'this' });
    expect(await starts()).toHaveLength(4);
    expect(db.event).toHaveLength(1);
  });

  it('"This and following" ends the series and its later changes', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(3), title: 'Recital' });
    await deleteEvent(HH, 'u1', { id, scope: 'following', occurrenceStart: week(2) });
    expect((await starts()).map(([s]) => s)).toEqual(['2026-11-02T15:00:00.000Z', '2026-11-09T15:00:00.000Z']);
    expect(db.event).toHaveLength(1);
  });

  it('"All events" from a changed date removes the series and every change', async () => {
    const id = await weeklySeries();
    await updateEvent(HH, 'u1', { id, scope: 'this', occurrenceStart: week(1), title: 'Special' });
    const override = db.event.find((e) => e.seriesId === id)!;
    await deleteEvent(HH, 'u1', { id: override.id, scope: 'all' });
    expect(db.event).toHaveLength(0);
    expect(db.rule).toHaveLength(0);
  });

  it('a one-off event is deleted as before', async () => {
    const dto = await createEvent(HH, 'u1', { title: 'Dentist', startAt: MON, allDay: false });
    await deleteEvent(HH, 'u1', { id: dto.eventId, scope: 'all' });
    expect(db.event).toHaveLength(0);
  });
});
