import { beforeEach, describe, expect, it, vi } from 'vitest';

// A tiny in-memory payments table, so the tests exercise the real `where`
// clauses the service builds rather than canned totals.
type Payment = { id: string; billId: string; amount: number; fee: number | null; cycleDueDate: Date | null };
let payments: Payment[] = [];

const matches = (p: Payment, where: { billId?: string; cycleDueDate?: Date | null }) =>
  (where.billId === undefined || p.billId === where.billId) &&
  (where.cycleDueDate === undefined ||
    (p.cycleDueDate?.getTime() ?? null) === (where.cycleDueDate?.getTime() ?? null));

const prisma = {
  bill: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  billPayment: {
    aggregate: vi.fn(async ({ where }) => ({
      _sum: { amount: payments.filter((p) => matches(p, where)).reduce((s, p) => s + p.amount, 0) },
    })),
    count: vi.fn(async ({ where }) => payments.filter((p) => matches(p, where)).length),
    findMany: vi.fn(async ({ where }) =>
      payments
        .filter((p) => matches(p, where))
        .map((p) => ({ ...p, householdId: 'h1', paidAt: new Date('2026-10-01T12:00:00Z'), notes: null, source: 'manual', confirmationNo: null, paidBy: null, createdById: null })),
    ),
    create: vi.fn(async ({ data }) => {
      payments.push({ id: `p${payments.length + 1}`, billId: data.billId, amount: data.amount, fee: data.fee, cycleDueDate: data.cycleDueDate ?? null });
      return {};
    }),
  },
  recurrenceRule: { update: vi.fn() },
  event: { updateMany: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/services/pointsService', () => ({ getPointsSettings: vi.fn(async () => ({ timezone: 'UTC' })) }));

const { listBills, getBillDetail, markBillPaid, countsTowardBalance } = await import('./billService');

const OCT_1 = new Date('2026-10-01T12:00:00Z');
const NOV_1 = new Date('2026-11-01T12:00:00Z');
const DEC_1 = new Date('2026-12-01T12:00:00Z');
const SEP_1 = new Date('2026-09-01T12:00:00Z');

const recurrence = {
  id: 'r1', kind: 'monthly', interval: 1, byWeekday: null, byMonthday: '1', cron: null,
  timezone: 'UTC', anchorDate: SEP_1, until: null, nextRunAt: NOV_1,
};
const bill = (over: Record<string, unknown>) => ({
  id: 'b1', householdId: 'h1', name: 'Mortgage', amount: 1850, currentCharges: null, currency: 'USD',
  dueDate: NOV_1, status: 'unpaid', category: null, autoPay: true, notes: null, source: 'manual',
  reference: null, recurrenceId: 'r1', recurrence, assignee: null, createdById: null,
  createdAt: SEP_1, ...over,
});
const mortgage = bill({});
const water = bill({ id: 'b2', name: 'Water', amount: 64.3, dueDate: new Date('2026-10-06T12:00:00Z'), recurrenceId: null, recurrence: null, autoPay: false });

describe('countsTowardBalance', () => {
  it('counts every payment on a one-off bill', () => {
    expect(countsTowardBalance(water, null)).toBe(true);
    expect(countsTowardBalance(water, SEP_1)).toBe(true);
  });
  it('counts only the current due date on a recurring bill', () => {
    expect(countsTowardBalance(mortgage, NOV_1)).toBe(true);
    expect(countsTowardBalance(mortgage, OCT_1)).toBe(false);
    expect(countsTowardBalance(mortgage, null)).toBe(false);
  });
});

describe('recurring bill balance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Two earlier cycles paid, one of them recorded before cycleDueDate existed.
    payments = [
      { id: 'p1', billId: 'b1', amount: 1850, fee: null, cycleDueDate: null },
      { id: 'p2', billId: 'b1', amount: 1850, fee: 2.5, cycleDueDate: OCT_1 },
      { id: 'p3', billId: 'b2', amount: 58.75, fee: null, cycleDueDate: null },
    ];
  });

  it('lists a recurring bill as still owed, despite earlier cycles being paid', async () => {
    prisma.bill.findMany.mockResolvedValueOnce([mortgage, water]);
    const [m, w] = await listBills('h1').then((all) => [all.find((b) => b.id === 'b1')!, all.find((b) => b.id === 'b2')!]);
    expect(m.paidTotal).toBe(0);
    expect(m.paymentCount).toBe(2);
    // One-off bills are unchanged: every payment counts.
    expect(w.paidTotal).toBeCloseTo(58.75);
    expect(w.paymentCount).toBe(1);
  });

  it('counts a part payment made this cycle', async () => {
    payments.push({ id: 'p4', billId: 'b1', amount: 400, fee: null, cycleDueDate: NOV_1 });
    prisma.bill.findMany.mockResolvedValueOnce([mortgage]);
    const [m] = await listBills('h1');
    expect(m.paidTotal).toBe(400);
    expect(m.paymentCount).toBe(3);
  });

  it('shows the full amount remaining on the bill page, with the whole history listed', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(mortgage);
    const detail = await getBillDetail('h1', 'b1');
    expect(detail.paidTotal).toBe(0);
    expect(detail.feeTotal).toBe(0);
    expect(detail.remaining).toBe(1850);
    expect(detail.payments).toHaveLength(2);
    expect(detail.paymentCount).toBe(2);
  });

  it('pays the full cycle by default, records the cycle, and rolls on', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(mortgage);
    prisma.bill.update.mockResolvedValueOnce({ ...mortgage, dueDate: DEC_1 });
    const result = await markBillPaid('h1', 'u1', { id: 'b1' } as never);
    const created = prisma.billPayment.create.mock.calls[0][0].data;
    expect(created.amount).toBe(1850);
    expect(created.cycleDueDate).toEqual(NOV_1);
    expect(prisma.bill.update.mock.calls[0][0].data).toMatchObject({ status: 'unpaid', dueDate: DEC_1 });
    // The new cycle starts with nothing paid.
    expect(result.paidTotal).toBe(0);
    expect(result.paymentCount).toBe(3);
  });

  it('still settles a one-off bill from what is left on it', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(water);
    prisma.bill.update.mockResolvedValueOnce({ ...water, status: 'paid' });
    await markBillPaid('h1', 'u1', { id: 'b2' } as never);
    const created = prisma.billPayment.create.mock.calls[0][0].data;
    expect(created.amount).toBeCloseTo(5.55);
    expect(prisma.bill.update.mock.calls[0][0].data).toEqual({ status: 'paid' });
  });
});
