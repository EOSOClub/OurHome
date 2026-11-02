import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';

// Taking back what a withdrawn OurHomeInbox email made (sync.ts calls this).

export interface WithdrawResult {
  /** removed: the bill it made is gone. kept: left for a person (`reason`). nothing: it made nothing here. */
  status: 'removed' | 'kept' | 'nothing';
  billId?: string;
  billName?: string;
  reason?: string;
}

/**
 * An email the importer brought in no longer counts as a bill (OurHomeInbox
 * withdrew it, say it was marked "Not a bill"). The bill it made goes, with
 * its calendar entry, but only while nobody has relied on it: a bill with any
 * payment recorded, or one a person made recurring, is kept and reported. A
 * payment recorded from the email is never undone here: it may have marked a
 * bill paid or moved a recurring one on, so a person checks it on the bill.
 */
export async function withdrawEmailDoc(householdId: string, messageId: string): Promise<WithdrawResult> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.billPayment.findFirst({
      where: { householdId, sourceMessageId: messageId },
      select: { billId: true, bill: { select: { name: true } } },
    });
    if (payment) {
      return {
        status: 'kept' as const,
        billId: payment.billId ?? undefined,
        billName: payment.bill?.name,
        reason: 'a payment was recorded from this email: check it on the bill, and remove it there if it’s wrong',
      };
    }

    const bill = await tx.bill.findFirst({
      where: { householdId, source: 'email', sourceMessageId: messageId },
      select: { id: true, name: true, recurrenceId: true, _count: { select: { payments: true } } },
    });
    if (!bill) return { status: 'nothing' as const };
    if (bill._count.payments > 0) {
      return { status: 'kept' as const, billId: bill.id, billName: bill.name, reason: 'a payment is recorded on this bill: delete it by hand if it isn’t a bill' };
    }
    if (bill.recurrenceId) {
      return { status: 'kept' as const, billId: bill.id, billName: bill.name, reason: 'this bill was made recurring: delete it by hand if it isn’t a bill' };
    }

    await tx.event.deleteMany({ where: { householdId, billId: bill.id } });
    await tx.bill.delete({ where: { id: bill.id } });
    await logActivity(
      {
        householdId,
        actorId: null,
        verb: 'deleted',
        subjectType: 'bill',
        subjectId: bill.id,
        message: `removed bill “${bill.name}”: its email no longer counts as a bill`,
      },
      tx,
    );
    return { status: 'removed' as const, billId: bill.id };
  });
}
