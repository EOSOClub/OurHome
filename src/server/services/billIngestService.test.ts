import { beforeEach, describe, expect, it, vi } from 'vitest';

const OCT_1 = new Date('2026-10-01T12:00:00Z');
const NOV_1 = new Date('2026-11-01T12:00:00Z');
const DEC_1 = new Date('2026-12-01T12:00:00Z');

// Last cycle's payment is on file; the bill has rolled on to Nov 1.
type Payment = { billId: string; amount: number; cycleDueDate: Date | null };
let payments: Payment[] = [];

const prisma = {
  bill: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  billPayment: {
    findFirst: vi.fn(async () => null),
    aggregate: vi.fn(async ({ where }) => ({
      _sum: {
        amount: payments
          .filter((p) => p.billId === where.billId && (where.cycleDueDate === undefined || p.cycleDueDate?.getTime() === where.cycleDueDate.getTime()))
          .reduce((s, p) => s + p.amount, 0),
      },
    })),
    create: vi.fn<(args: { data: Record<string, unknown> }) => Promise<{ id: string }>>(async () => ({ id: 'pay1' })),
  },
  recurrenceRule: { update: vi.fn() },
  event: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'ev1' })), update: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/services/pointsService', () => ({ getPointsSettings: vi.fn(async () => ({ timezone: 'UTC' })) }));

const { ingestFinancialDoc } = await import('./billIngestService');

const mortgage = {
  id: 'b1', householdId: 'h1', name: 'Mortgage', amount: 1850, currency: 'USD', dueDate: NOV_1,
  status: 'unpaid', reference: 'LHL-0048', recurrenceId: 'r1',
  recurrence: { id: 'r1', kind: 'monthly', interval: 1, byWeekday: null, byMonthday: '1', cron: null, anchorDate: OCT_1, until: null },
};
const receipt = (amount: number) =>
  ({ kind: 'receipt', messageId: `<m${amount}@example>`, reference: 'LHL-0048', amount, paidDate: new Date('2026-10-28T12:00:00Z') }) as never;

describe('Paperless receipt on a recurring bill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    payments = [{ billId: 'b1', amount: 1850, cycleDueDate: OCT_1 }];
    prisma.bill.findFirst.mockResolvedValueOnce(mortgage);
    prisma.bill.update.mockImplementation(async ({ data }) => ({ ...mortgage, ...data }));
  });

  it('splits off the card fee and rolls the bill on, ignoring last cycle', async () => {
    const result = await ingestFinancialDoc('h1', receipt(1852.5), { source: 'paperless' });
    expect(result.status).toBe('linked');
    const created = prisma.billPayment.create.mock.calls[0][0].data;
    expect(created.amount).toBe(1850);
    expect(created.fee).toBeCloseTo(2.5);
    expect(created.cycleDueDate).toEqual(NOV_1);
    expect(prisma.bill.update.mock.calls[0][0].data).toMatchObject({ status: 'unpaid', dueDate: DEC_1 });
  });

  it('leaves the bill where it is after a part payment', async () => {
    await ingestFinancialDoc('h1', receipt(500), { source: 'paperless' });
    const created = prisma.billPayment.create.mock.calls[0][0].data;
    expect(created.amount).toBe(500);
    expect(created.fee).toBeNull();
    expect(prisma.recurrenceRule.update).not.toHaveBeenCalled();
    expect(prisma.bill.update.mock.calls[0][0].data).toEqual({ status: 'unpaid' });
  });
});
