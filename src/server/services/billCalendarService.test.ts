import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory bills and events, so putting a bill on the calendar, finding it
// there and keeping it in step run against real rows.
type Row = Record<string, unknown> & { id: string };
const db = { bill: [] as Row[], event: [] as Row[] };
let seq = 0;

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(row, w));
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[] };
      return c.in ? c.in.includes(v) : false;
    }
    return v === cond;
  });
}

const table = (name: 'bill' | 'event') => ({
  findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => db[name].find((r) => matches(r, where)) ?? null),
  findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => db[name].filter((r) => matches(r, where))),
  count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => db[name].filter((r) => matches(r, where)).length),
  create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const row: Row = { id: `${name}${++seq}`, billId: null, recurrence: null, assignee: null, ...data };
    db[name].push(row);
    return row;
  }),
  update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = db[name].find((r) => r.id === where.id)!;
    for (const [k, v] of Object.entries(data)) if (v !== undefined) row[k] = v;
    return row;
  }),
  deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const before = db[name].length;
    db[name] = db[name].filter((r) => !matches(r, where));
    return { count: before - db[name].length };
  }),
});

const prisma = {
  bill: table('bill'),
  event: table('event'),
  billPayment: {
    aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })),
    count: vi.fn(async () => 0),
    findMany: vi.fn(async () => []),
  },
  user: { findFirst: vi.fn(async () => null) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/services/pointsService', () => ({
  getPointsSettings: vi.fn(async () => ({ timezone: 'America/Chicago' })),
}));

const { addBillToCalendar, billEventTitle, billIdsOnCalendar, removeBillFromCalendar } =
  await import('./billCalendarService');
const { createBill, listBills, updateBill } = await import('./billService');

const HH = 'hh1';
// Due Nov 20 at noon, Chicago.
const DUE = new Date('2026-11-20T18:00:00.000Z');

function seedBill(over: Record<string, unknown> = {}) {
  const row: Row = {
    id: `bill${++seq}`, householdId: HH, name: 'Electric', kind: 'bill', amount: 120, currency: 'USD',
    dueDate: DUE, reference: null, status: 'unpaid', recurrenceId: null, recurrence: null, assignee: null,
    createdAt: new Date(), ...over,
  };
  db.bill.push(row);
  return row;
}

/** An event made by the old "Add to calendar" button: local midnight on the due day. */
function seedOldCopy(title = 'Electric', startAt = new Date('2026-11-20T06:00:00.000Z')) {
  const row: Row = { id: `event${++seq}`, householdId: HH, title, allDay: true, startAt, billId: null };
  db.event.push(row);
  return row;
}

beforeEach(() => {
  db.bill = [];
  db.event = [];
  seq = 0;
});

describe('billEventTitle', () => {
  it('says a bill is due and a subscription renews', () => {
    expect(billEventTitle({ name: 'Electric', kind: 'bill' })).toBe('Bill due: Electric');
    expect(billEventTitle({ name: 'Netflix', kind: 'subscription' })).toBe('Netflix renews');
    // Email and Paperless bills, as before.
    expect(billEventTitle({ name: 'Water' })).toBe('Bill due: Water');
  });
});

describe('putting a bill on the calendar', () => {
  it('a bill starts off the calendar, and Add puts it on, linked', async () => {
    const bill = seedBill();
    expect((await listBills(HH))[0].onCalendar).toBe(false);
    await addBillToCalendar(HH, 'u1', bill.id);
    expect(db.event).toHaveLength(1);
    expect(db.event[0]).toMatchObject({ billId: bill.id, kind: 'bill', title: 'Bill due: Electric', allDay: true, startAt: DUE });
    expect((await listBills(HH))[0].onCalendar).toBe(true);
    // A second Add changes nothing.
    await addBillToCalendar(HH, 'u1', bill.id);
    expect(db.event).toHaveLength(1);
  });

  it('counts an old copy as on the calendar, and Add takes it over instead of adding another', async () => {
    const bill = seedBill();
    const copy = seedOldCopy();
    seedOldCopy('Electric', new Date('2026-11-21T06:00:00.000Z')); // another day: not it
    seedOldCopy('Gas'); // another name: not it
    expect(await billIdsOnCalendar(HH, [bill as never])).toEqual(new Set([bill.id]));
    await addBillToCalendar(HH, 'u1', bill.id);
    expect(db.event).toHaveLength(3);
    expect(db.event.find((e) => e.id === copy.id)).toMatchObject({ billId: bill.id, title: 'Bill due: Electric' });
  });

  it('needs a due date', async () => {
    const bill = seedBill({ dueDate: null });
    await expect(addBillToCalendar(HH, 'u1', bill.id)).rejects.toThrow('due date');
  });

  it('Remove takes off its entry and an old copy, nothing else', async () => {
    const bill = seedBill();
    const other = seedBill({ name: 'Gas' });
    await addBillToCalendar(HH, 'u1', bill.id);
    await addBillToCalendar(HH, 'u1', other.id);
    seedOldCopy();
    const plain = { id: 'party', householdId: HH, title: 'Party', allDay: false, startAt: DUE, billId: null };
    db.event.push(plain);
    await removeBillFromCalendar(HH, 'u1', bill.id);
    expect(db.event.map((e) => e.title).sort()).toEqual(['Bill due: Gas', 'Party']);
  });
});

describe('bills made or changed with a calendar entry', () => {
  const input = {
    kind: 'subscription' as const,
    name: 'Netflix',
    amount: 15.49,
    dueDate: DUE,
    autoPay: true,
  };

  it('a subscription made on the calendar is on it as it’s saved', async () => {
    const dto = await createBill(HH, 'u1', { ...input, onCalendar: true });
    expect(dto.onCalendar).toBe(true);
    expect(db.event).toHaveLength(1);
    expect(db.event[0]).toMatchObject({ kind: 'subscription', title: 'Netflix renews', billId: dto.id });
  });

  it('one made on the Bills page is not', async () => {
    const dto = await createBill(HH, 'u1', input);
    expect(dto.onCalendar).toBe(false);
    expect(db.event).toHaveLength(0);
  });

  it('a rename or new date moves its entry; no date takes it off', async () => {
    const dto = await createBill(HH, 'u1', { ...input, onCalendar: true });
    const later = new Date('2026-12-20T18:00:00.000Z');
    await updateBill(HH, 'u1', { id: dto.id, name: 'Netflix Premium', dueDate: later });
    expect(db.event[0]).toMatchObject({ title: 'Netflix Premium renews', startAt: later });
    await updateBill(HH, 'u1', { id: dto.id, dueDate: null });
    expect(db.event).toHaveLength(0);
  });

  it('a bill off the calendar stays off when changed', async () => {
    const dto = await createBill(HH, 'u1', input);
    await updateBill(HH, 'u1', { id: dto.id, name: 'Hulu' });
    expect(db.event).toHaveLength(0);
  });

  it('only a subscription keeps a trial date', async () => {
    const trial = new Date('2026-11-15T18:00:00.000Z');
    const dto = await createBill(HH, 'u1', { ...input, trialEndsAt: trial });
    expect(dto.trialEndsAt).toBe(trial.toISOString());
    // Switched to a bill, the trial goes.
    const bill = await updateBill(HH, 'u1', { id: dto.id, kind: 'bill' });
    expect(bill.trialEndsAt).toBeNull();
    await expect(updateBill(HH, 'u1', { id: dto.id, trialEndsAt: trial })).rejects.toThrow('free trial');
  });
});
