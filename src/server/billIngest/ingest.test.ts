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
    update: vi.fn<(args: { where: { id: string }; data: Record<string, unknown> }) => Promise<{ id: string }>>(async ({ where }) => ({ id: where.id })),
    count: vi.fn(async ({ where }: { where: { billId: string; cycleDueDate?: Date } }) =>
      payments.filter((p) => p.billId === where.billId && (where.cycleDueDate === undefined || p.cycleDueDate?.getTime() === where.cycleDueDate.getTime())).length,
    ),
  },
  recurrenceRule: { update: vi.fn() },
  // count: the bill already has its calendar entry, so a payment moves it along.
  event: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: 'ev1' })), update: vi.fn(), count: vi.fn(async () => 1) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
vi.mock('@/server/services/activityService', () => ({ logActivity: vi.fn() }));
vi.mock('@/server/services/pointsService', () => ({ getPointsSettings: vi.fn(async () => ({ timezone: 'UTC' })) }));

const { ingestFinancialDoc } = await import('./ingest');

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

// OurHomeInbox pairs its own payments (contract v2): the inbox import passes
// receiptPairing 'reference'. The receipt is linked only by the reference it
// sends, with the fee as sent; OurHome's own matching is never tried.
describe('OurHomeInbox receipt, paired by reference', () => {
  const EMAIL = { source: 'email', receiptPairing: 'reference' } as const;
  const cityWater = {
    id: 'b5', householdId: 'h1', name: 'City Water', amount: 100, currency: 'USD', dueDate: NOV_1,
    status: 'unpaid', reference: 'ohi:0123456789abcdef01234567', recurrenceId: null, recurrence: null,
  };
  const paid = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'receipt', messageId: '<pay1@city.example>', reference: 'ohi:0123456789abcdef01234567',
      amount: 104, fee: 4, baseAmount: 100, paidDate: new Date('2026-11-08T12:00:00Z'),
      // Present, but never used to find the bill for an email payment.
      accountNo: '55-1234', billerKey: 'ourhomeinbox-biller:3', billerEmail: 'billing@city.example',
      ...over,
    }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.bill.findFirst.mockReset();
    prisma.bill.findMany.mockReset();
    payments = [];
    prisma.bill.update.mockImplementation(async ({ data }) => ({ ...cityWater, ...data }));
    prisma.bill.create.mockResolvedValue({ id: 'nb1', name: 'City Water payment' });
  });

  it('links the payment to the bill with that reference, keeping the sent fee and paid late', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(cityWater);
    const result = await ingestFinancialDoc('h1', paid({ paidLate: true }), EMAIL);
    expect(result).toMatchObject({ status: 'linked', billId: 'b5' });
    expect(prisma.bill.findFirst).toHaveBeenCalledOnce();
    expect(prisma.bill.findFirst.mock.calls[0][0].where).toEqual({ householdId: 'h1', reference: 'ohi:0123456789abcdef01234567' });
    // The newest, should two bills ever share a reference.
    expect(prisma.bill.findFirst.mock.calls[0][0].orderBy).toEqual({ createdAt: 'desc' });
    expect(prisma.bill.findMany).not.toHaveBeenCalled();
    const created = prisma.billPayment.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ billId: 'b5', amount: 100, fee: 4, paidLate: true, source: 'email', sourceMessageId: '<pay1@city.example>' });
    expect(prisma.bill.update.mock.calls[0][0].data).toEqual({ status: 'paid' });
  });

  it('uses fee and baseAmount as sent, with no fee band of its own', async () => {
    // A fee far outside OurHome's band is still taken as sent.
    prisma.bill.findFirst.mockResolvedValueOnce(cityWater);
    await ingestFinancialDoc('h1', paid({ amount: 150, fee: 50, baseAmount: 100 }), EMAIL);
    expect(prisma.billPayment.create.mock.calls[0][0].data).toMatchObject({ amount: 100, fee: 50, paidLate: false });

    // Nothing sent: no fee is inferred from the bill, the whole amount is applied.
    prisma.bill.findFirst.mockResolvedValueOnce(cityWater);
    await ingestFinancialDoc('h1', paid({ messageId: '<pay2@x>', amount: 103, fee: undefined, baseAmount: undefined }), EMAIL);
    expect(prisma.billPayment.create.mock.calls[1][0].data).toMatchObject({ amount: 103, fee: null });
  });

  it('skips a payment whose bill is not here, without trying the account number or biller', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(null);
    const result = await ingestFinancialDoc('h1', paid(), EMAIL);
    expect(result).toMatchObject({ status: 'skipped', reason: "Its bill isn't in OurHome" });
    expect(prisma.bill.findFirst).toHaveBeenCalledOnce();
    expect(prisma.bill.findMany).not.toHaveBeenCalled();
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.bill.create).not.toHaveBeenCalled();
  });

  it('skips a payment on a bill already paid here', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce({ ...cityWater, status: 'paid' });
    const marked = await ingestFinancialDoc('h1', paid(), EMAIL);
    expect(marked).toMatchObject({ status: 'skipped', reason: 'This bill is already paid in OurHome' });

    // Unpaid on paper, but the payments recorded already cover it.
    payments = [{ billId: 'b5', amount: 100, cycleDueDate: null }];
    prisma.bill.findFirst.mockResolvedValueOnce(cityWater);
    const covered = await ingestFinancialDoc('h1', paid(), EMAIL);
    expect(covered).toMatchObject({ status: 'skipped', reason: 'This bill is already paid in OurHome' });
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.bill.update).not.toHaveBeenCalled();
  });

  it('still takes a part payment on a bill with something left to pay', async () => {
    payments = [{ billId: 'b5', amount: 40, cycleDueDate: null }];
    prisma.bill.findFirst.mockResolvedValueOnce(cityWater);
    const result = await ingestFinancialDoc('h1', paid({ amount: 30, fee: 0, baseAmount: 30 }), EMAIL);
    expect(result.status).toBe('linked');
    expect(prisma.billPayment.create.mock.calls[0][0].data).toMatchObject({ amount: 30, fee: null });
    expect(prisma.bill.update.mock.calls[0][0].data).toEqual({ status: 'unpaid' });
  });

  it('makes a payment with no reference (Paid on its own) a paid bill, matching nothing', async () => {
    const result = await ingestFinancialDoc('h1', paid({ reference: undefined, fee: undefined, baseAmount: undefined, paidLate: true }), EMAIL);
    expect(result).toMatchObject({ status: 'created', billId: 'nb1' });
    expect(prisma.bill.findFirst).not.toHaveBeenCalled();
    expect(prisma.bill.findMany).not.toHaveBeenCalled();
    expect(prisma.bill.create.mock.calls[0][0].data).toMatchObject({ status: 'paid', source: 'email', amount: 104 });
    expect(prisma.billPayment.create.mock.calls[0][0].data).toMatchObject({ billId: 'nb1', amount: 104, paidLate: true });
  });

  it('records an email payment once, even when OurHomeInbox offers it again', async () => {
    prisma.billPayment.findFirst.mockResolvedValueOnce({ id: 'pay1', billId: 'b5', source: 'email' } as never);
    const result = await ingestFinancialDoc('h1', paid(), EMAIL);
    expect(result).toMatchObject({ status: 'duplicate', paymentId: 'pay1' });
    expect(prisma.bill.findFirst).not.toHaveBeenCalled();
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.billPayment.update).not.toHaveBeenCalled();
  });

  it('keeps a bill-less payment from another source a duplicate', async () => {
    prisma.billPayment.findFirst.mockResolvedValueOnce({ id: 'pay1', billId: null, source: 'manual' } as never);
    const result = await ingestFinancialDoc('h1', paid(), EMAIL);
    expect(result).toMatchObject({ status: 'duplicate', paymentId: 'pay1' });
    expect(prisma.billPayment.update).not.toHaveBeenCalled();
  });

  // The household deleted the bill (its payment stays, with no bill), then
  // OurHomeInbox sent the bill again: the payment goes back on it.
  describe('an email payment whose bill was deleted', () => {
    const orphan = { id: 'orphan1', billId: null, source: 'email' };

    it('attaches the same payment to its bill when the bill is back and unpaid', async () => {
      prisma.billPayment.findFirst.mockResolvedValueOnce(orphan as never);
      prisma.bill.findFirst.mockResolvedValueOnce(cityWater);
      const result = await ingestFinancialDoc('h1', paid({ paidLate: true }), EMAIL);
      expect(result).toMatchObject({ status: 'linked', billId: 'b5', paymentId: 'orphan1' });
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
      const update = prisma.billPayment.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'orphan1' });
      expect(update.data).toMatchObject({
        billId: 'b5', amount: 100, fee: 4, cycleDueDate: NOV_1, paidLate: true,
        reference: 'ohi:0123456789abcdef01234567', paidAt: new Date('2026-11-08T12:00:00Z'),
      });
      expect(prisma.bill.update.mock.calls[0][0].data).toEqual({ status: 'paid' });
    });

    it('leaves it alone when its bill is not here', async () => {
      prisma.billPayment.findFirst.mockResolvedValueOnce(orphan as never);
      prisma.bill.findFirst.mockResolvedValueOnce(null);
      const result = await ingestFinancialDoc('h1', paid(), EMAIL);
      expect(result).toMatchObject({ status: 'skipped', reason: "Its bill isn't in OurHome" });
      expect(prisma.billPayment.update).not.toHaveBeenCalled();
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
    });

    it('leaves it alone when its bill is already paid here', async () => {
      prisma.billPayment.findFirst.mockResolvedValueOnce(orphan as never);
      prisma.bill.findFirst.mockResolvedValueOnce({ ...cityWater, status: 'paid' });
      const result = await ingestFinancialDoc('h1', paid(), EMAIL);
      expect(result).toMatchObject({ status: 'skipped', reason: 'This bill is already paid in OurHome' });
      expect(prisma.billPayment.update).not.toHaveBeenCalled();
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
    });

    it('attaches a Paid on its own payment to its new paid bill, without a second payment', async () => {
      prisma.billPayment.findFirst.mockResolvedValueOnce(orphan as never);
      const result = await ingestFinancialDoc('h1', paid({ reference: undefined, fee: undefined, baseAmount: undefined }), EMAIL);
      expect(result).toMatchObject({ status: 'created', billId: 'nb1', paymentId: 'orphan1' });
      expect(prisma.bill.create).toHaveBeenCalledOnce();
      expect(prisma.billPayment.create).not.toHaveBeenCalled();
      const update = prisma.billPayment.update.mock.calls[0][0];
      expect(update.where).toEqual({ id: 'orphan1' });
      expect(update.data).toMatchObject({ billId: 'nb1', amount: 104, fee: null });
    });
  });
});

// Paperless (and any import without receiptPairing) keeps OurHome's own matching.
describe('Paperless receipt matching, unchanged', () => {
  const PAPERLESS = { source: 'paperless', createUnmatchedReceipts: false } as const;
  const power = {
    id: 'b7', householdId: 'h1', name: 'Power', amount: 120, currency: 'USD', dueDate: NOV_1,
    status: 'unpaid', reference: 'GEN-AAAA', accountNo: '77-9', billerKey: 'paperless-correspondent:4',
    recurrenceId: null, recurrence: null,
  };
  const doc = (over: Record<string, unknown>) =>
    ({ kind: 'receipt', messageId: 'paperless:90', amount: 123.6, paidDate: new Date('2026-11-02T12:00:00Z'), ...over }) as never;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.bill.findFirst.mockReset();
    prisma.bill.findMany.mockReset();
    payments = [];
    prisma.bill.update.mockImplementation(async ({ data }) => ({ ...power, ...data }));
  });

  it('falls back from the reference to the account number', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(power);
    const result = await ingestFinancialDoc('h1', doc({ accountNo: '77-9' }), PAPERLESS);
    expect(result).toMatchObject({ status: 'linked', billId: 'b7' });
    expect(prisma.bill.findFirst.mock.calls[1][0].where).toEqual({ householdId: 'h1', accountNo: '77-9', status: 'unpaid' });
    // The overage within the band is split off as the card fee.
    const created = prisma.billPayment.create.mock.calls[0][0].data;
    expect(created.amount).toBe(120);
    expect(created.fee).toBeCloseTo(3.6);
    expect(created.paidLate).toBe(false);
  });

  it('falls back to the biller with the amount inside the card-fee band', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(null);
    prisma.bill.findMany.mockResolvedValueOnce([power]);
    const result = await ingestFinancialDoc('h1', doc({ billerKey: 'paperless-correspondent:4', amount: 126 }), PAPERLESS);
    expect(result).toMatchObject({ status: 'linked', billId: 'b7' });
    // The band is the larger of 6.00 or 4%: 6.00 on a 120.00 bill.
    expect(prisma.billPayment.create.mock.calls[0][0].data).toMatchObject({ amount: 120, fee: 6 });
  });

  it('reports a payment outside the band as having no bill', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(null);
    prisma.bill.findMany.mockResolvedValueOnce([power]);
    const result = await ingestFinancialDoc('h1', doc({ billerKey: 'paperless-correspondent:4', amount: 126.5 }), PAPERLESS);
    expect(result).toMatchObject({ status: 'skipped', reason: 'no matching unpaid bill' });
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it('keeps a payment left without a bill a duplicate', async () => {
    prisma.billPayment.findFirst.mockResolvedValueOnce({ id: 'pay9', billId: null, source: 'email' } as never);
    const result = await ingestFinancialDoc('h1', doc({ accountNo: '77-9' }), { ...PAPERLESS, receiptPairing: 'match' });
    expect(result).toMatchObject({ status: 'duplicate', paymentId: 'pay9' });
    expect(prisma.bill.findFirst).not.toHaveBeenCalled();
    expect(prisma.billPayment.update).not.toHaveBeenCalled();
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });
});

describe('review fixes: the importer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.bill.findFirst.mockReset();
    prisma.bill.findMany.mockReset();
    payments = [];
    prisma.bill.create.mockResolvedValue({ id: 'nb1', name: 'Paid' });
  });

  it('skips a paired payment for a recurring bill that already rolled past its email cycle', async () => {
    // Paid by hand for Oct 1, then rolled on to Nov 1: the email's bill is paid.
    payments = [{ billId: 'b1', amount: 1850, cycleDueDate: OCT_1 }];
    prisma.bill.findFirst.mockResolvedValueOnce(mortgage);
    const result = await ingestFinancialDoc('h1', receipt(1850), { source: 'email', receiptPairing: 'reference' });
    expect(result).toMatchObject({ status: 'skipped', reason: 'This bill is already paid in OurHome' });
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.recurrenceRule.update).not.toHaveBeenCalled();

    // A payment recorded before cycleDueDate existed counts as another cycle too.
    payments = [{ billId: 'b1', amount: 1850, cycleDueDate: null }];
    prisma.bill.findFirst.mockResolvedValueOnce(mortgage);
    const old = await ingestFinancialDoc('h1', receipt(1850), { source: 'email', receiptPairing: 'reference' });
    expect(old.status).toBe('skipped');
  });

  it('still pays a recurring bill that has not rolled yet', async () => {
    prisma.bill.findFirst.mockResolvedValueOnce(mortgage);
    prisma.bill.update.mockImplementation(async ({ data }) => ({ ...mortgage, ...data }));
    const result = await ingestFinancialDoc('h1', receipt(1850), { source: 'email', receiptPairing: 'reference' });
    expect(result.status).toBe('linked');
    expect(prisma.bill.update.mock.calls[0][0].data).toMatchObject({ status: 'unpaid', dueDate: DEC_1 });
  });

  it('gives a Paid on its own bill the generated reference, never its invoice or confirmation number', async () => {
    const own = { kind: 'receipt', messageId: '<own@x>', amount: 25, invoiceNo: 'INV-77', confirmationNo: 'CONF-9' } as never;
    const result = await ingestFinancialDoc('h1', own, { source: 'email', receiptPairing: 'reference' });
    expect(result.status).toBe('created');
    expect(result.reference).toMatch(/^GEN-[0-9A-F]{10}$/);
    expect(prisma.bill.create.mock.calls[0][0].data).toMatchObject({ reference: result.reference, invoiceNo: 'INV-77', confirmationNo: 'CONF-9' });
    expect(prisma.billPayment.create.mock.calls[0][0].data.reference).toBe(result.reference);
  });

  it('keeps Paperless resolving the reference from the invoice or confirmation number', async () => {
    prisma.bill.findFirst.mockResolvedValue(null);
    const result = await ingestFinancialDoc('h1', { kind: 'receipt', messageId: 'paperless:5', amount: 25, confirmationNo: 'CONF-9' } as never, { source: 'paperless', createUnmatchedReceipts: false });
    expect(result.reference).toBe('CONF-9');
    expect(prisma.bill.findFirst.mock.calls[0][0].where).toEqual({ householdId: 'h1', reference: 'CONF-9' });
  });

  it('does not put a recurring bill back on an old cycle when its document comes again', async () => {
    // Fix for every import (Paperless too): the bill was made recurring and has rolled on
    // (paid for Oct 1, now due Nov 1).
    payments = [{ billId: 'b1', amount: 90, cycleDueDate: OCT_1 }];
    const bill = { kind: 'bill', messageId: '<bill@x>', reference: 'INV-1', amount: 90, dueDate: OCT_1, subject: 'Water' } as never;
    prisma.bill.findFirst.mockResolvedValueOnce({ id: 'b1', recurrenceId: 'r1', dueDate: NOV_1 });
    prisma.bill.update.mockImplementation(async ({ data }) => ({ ...mortgage, ...data, amount: mortgage.amount, dueDate: NOV_1 }));
    await ingestFinancialDoc('h1', bill, { source: 'paperless' });
    const update = prisma.bill.update.mock.calls[0][0].data;
    expect(update.amount).toBeUndefined();
    expect(update.dueDate).toBeUndefined();
    expect(update).toMatchObject({ reference: 'INV-1', name: 'Water' });

    // A one-off bill still takes the corrected values.
    prisma.bill.findFirst.mockResolvedValueOnce({ id: 'b2', recurrenceId: null, dueDate: OCT_1 });
    await ingestFinancialDoc('h1', bill, { source: 'paperless' });
    expect(prisma.bill.update.mock.calls[1][0].data).toMatchObject({ amount: 90, dueDate: OCT_1 });
  });
});

describe('follow-up: recurring bills that have not rolled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.bill.findFirst.mockReset();
    prisma.bill.findMany.mockReset();
    payments = [];
  });

  it('lets a recurring bill that never rolled take a corrected amount and due date', async () => {
    const bill = { kind: 'bill', messageId: '<bill@x>', reference: 'INV-1', amount: 95, dueDate: NOV_1, subject: 'Water' } as never;
    prisma.bill.findFirst.mockResolvedValueOnce({ id: 'b1', recurrenceId: 'r1', dueDate: NOV_1 });
    prisma.bill.update.mockImplementation(async ({ data }) => ({ ...mortgage, ...data }));
    await ingestFinancialDoc('h1', bill, { source: 'paperless' });
    expect(prisma.bill.update.mock.calls[0][0].data).toMatchObject({ amount: 95, dueDate: NOV_1 });

    // A payment for the current cycle only (a part payment) is not a roll either.
    payments = [{ billId: 'b1', amount: 40, cycleDueDate: NOV_1 }];
    prisma.bill.findFirst.mockResolvedValueOnce({ id: 'b1', recurrenceId: 'r1', dueDate: NOV_1 });
    await ingestFinancialDoc('h1', bill, { source: 'email' });
    expect(prisma.bill.update.mock.calls[1][0].data).toMatchObject({ amount: 95, dueDate: NOV_1 });
  });

  it('links a paired payment on a recurring bill with a payment for its current cycle only', async () => {
    payments = [{ billId: 'b1', amount: 500, cycleDueDate: NOV_1 }];
    prisma.bill.findFirst.mockResolvedValueOnce(mortgage);
    prisma.bill.update.mockImplementation(async ({ data }) => ({ ...mortgage, ...data }));
    const result = await ingestFinancialDoc('h1', receipt(1350), { source: 'email', receiptPairing: 'reference' });
    expect(result.status).toBe('linked');
    expect(prisma.billPayment.create.mock.calls[0][0].data).toMatchObject({ amount: 1350, cycleDueDate: NOV_1 });
    // The cycle is now covered, so the bill rolls on.
    expect(prisma.bill.update.mock.calls[0][0].data).toMatchObject({ status: 'unpaid', dueDate: DEC_1 });
  });
});
