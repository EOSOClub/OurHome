import { beforeEach, describe, expect, it, vi } from 'vitest';

// withdrawEmailDoc: an email that no longer counts as a bill takes its bill
// back, unless someone has relied on it.

const prisma = {
  bill: { findFirst: vi.fn(), delete: vi.fn() },
  billPayment: { findFirst: vi.fn() },
  event: { deleteMany: vi.fn() },
  // The queue of changes reported to OurHomeInbox: a withdrawal is never one.
  inboxChange: { create: vi.fn() },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
};
vi.mock('@/server/db/prisma', () => ({ prisma }));
const activity = { logActivity: vi.fn() };
vi.mock('@/server/services/activityService', () => activity);
vi.mock('@/server/services/pointsService', () => ({ getPointsSettings: vi.fn(async () => ({ timezone: 'UTC' })) }));

const { withdrawEmailDoc } = await import('./withdraw');

const bill = (over: Record<string, unknown> = {}) => ({ id: 'b1', name: 'City Water', recurrenceId: null, _count: { payments: 0 }, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  prisma.billPayment.findFirst.mockResolvedValue(null);
});

describe('withdrawEmailDoc', () => {
  it('removes the unpaid bill the email made, with its calendar entry', async () => {
    prisma.bill.findFirst.mockResolvedValue(bill());
    await expect(withdrawEmailDoc('h1', '<m1@x>')).resolves.toEqual({ status: 'removed', billId: 'b1' });
    expect(prisma.bill.findFirst.mock.calls[0][0].where).toEqual({ householdId: 'h1', source: 'email', sourceMessageId: '<m1@x>' });
    expect(prisma.event.deleteMany).toHaveBeenCalledWith({ where: { householdId: 'h1', billId: 'b1' } });
    expect(prisma.bill.delete).toHaveBeenCalledWith({ where: { id: 'b1' } });
    expect(activity.logActivity.mock.calls[0][0]).toMatchObject({ verb: 'deleted', actorId: null, subjectId: 'b1' });
    // OurHomeInbox withdrew it, so it already knows: nothing is reported back.
    expect(prisma.inboxChange.create).not.toHaveBeenCalled();
  });

  it('keeps a bill with a payment recorded on it', async () => {
    prisma.bill.findFirst.mockResolvedValue(bill({ _count: { payments: 1 } }));
    await expect(withdrawEmailDoc('h1', '<m1@x>')).resolves.toMatchObject({ status: 'kept', billId: 'b1', billName: 'City Water' });
    expect(prisma.bill.delete).not.toHaveBeenCalled();
  });

  it('keeps a bill someone made recurring', async () => {
    prisma.bill.findFirst.mockResolvedValue(bill({ recurrenceId: 'r1' }));
    await expect(withdrawEmailDoc('h1', '<m1@x>')).resolves.toMatchObject({ status: 'kept', reason: expect.stringMatching(/recurring/) });
    expect(prisma.bill.delete).not.toHaveBeenCalled();
  });

  it('never undoes a payment recorded from the email', async () => {
    prisma.billPayment.findFirst.mockResolvedValue({ billId: 'b9', bill: { name: 'Midco' } });
    await expect(withdrawEmailDoc('h1', '<m1@x>')).resolves.toMatchObject({ status: 'kept', billId: 'b9', billName: 'Midco' });
    expect(prisma.bill.findFirst).not.toHaveBeenCalled();
    expect(prisma.bill.delete).not.toHaveBeenCalled();
  });

  it('does nothing when the email made nothing here', async () => {
    prisma.bill.findFirst.mockResolvedValue(null);
    await expect(withdrawEmailDoc('h1', '<m1@x>')).resolves.toEqual({ status: 'nothing' });
    expect(prisma.event.deleteMany).not.toHaveBeenCalled();
  });
});
