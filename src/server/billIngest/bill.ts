import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { syncBillEvent } from '@/server/services/billCalendarService';
import { billName, billSel, fromLabel, hasRolledOn } from '@/server/billIngest/common';
import type { IngestOptions, IngestResult } from '@/server/billIngest/types';
import type { BillIngestInput } from '@/lib/validation/billIngest';

// A bill document: creates the bill, or updates the one the same email (or the
// same real invoice/confirmation number) made before.

export async function ingestBill(
  householdId: string,
  doc: BillIngestInput,
  reference: string,
  opts: Required<IngestOptions>,
): Promise<IngestResult> {
  const name = billName(doc);
  const from = fromLabel(opts.source);
  // What's owed by the due date is the total/balance. When a statement carries both
  // a balance (`totalDue`) and this period's charges (`amount`, e.g., a utility), the
  // balance is the headline amount and the current charges are kept as detail.
  const amount = doc.totalDue ?? doc.amount ?? 0;
  const currentCharges = doc.totalDue != null ? doc.amount ?? null : null;
  const notes = doc.subject ? `From ${from}: ${doc.subject}` : null;

  return prisma.$transaction(async (tx) => {
    // Same email re-sent, or a bill+receipt sharing a real invoice/confirmation.
    const existing = await tx.bill.findFirst({
      where: {
        householdId,
        OR: [{ sourceMessageId: doc.messageId }, { reference }],
      },
      select: { id: true, recurrenceId: true, dueDate: true },
    });

    const data = {
      reference,
      sourceMessageId: doc.messageId,
      source: opts.source,
      name,
      amount,
      currentCharges,
      currency: doc.currency ?? 'USD',
      dueDate: doc.dueDate ?? null,
      invoiceNo: doc.invoiceNo ?? null,
      accountNo: doc.accountNo ?? null,
      confirmationNo: doc.confirmationNo ?? null,
      billerEmail: doc.billerEmail ?? null,
      billerKey: doc.billerKey ?? null,
      sourceUrl: doc.sourceUrl ?? null,
      notes,
    };

    if (existing) {
      // A recurring bill that has rolled on (paying it moved the due date and
      // kept the amount) is past the cycle this document describes: the
      // document offered again must not put it back on that old, closed
      // cycle. One that hasn't rolled yet still takes corrected values, and
      // everything else always updates.
      // (Prisma leaves a field that is undefined as it is.)
      const rolled = await hasRolledOn(tx, existing);
      const update = rolled ? { ...data, amount: undefined, dueDate: undefined } : data;
      const bill = await tx.bill.update({ where: { id: existing.id }, data: update, select: billSel });
      const eventId = await syncBillEvent(tx, householdId, bill, opts.source);
      await logActivity(
        { householdId, actorId: null, verb: 'updated', subjectType: 'bill', subjectId: bill.id, message: `updated bill “${bill.name}” from ${from}` },
        tx,
      );
      return { status: 'updated' as const, kind: 'bill' as const, reference, billId: bill.id, eventId };
    }

    const bill = await tx.bill.create({ data: { householdId, status: 'unpaid', ...data }, select: billSel });
    const eventId = await syncBillEvent(tx, householdId, bill, opts.source);
    await logActivity(
      { householdId, actorId: null, verb: 'created', subjectType: 'bill', subjectId: bill.id, message: `added bill “${bill.name}” from ${from}`, metadata: { amount, reference } },
      tx,
    );
    return { status: 'created' as const, kind: 'bill' as const, reference, billId: bill.id, eventId };
  });
}
