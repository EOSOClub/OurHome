import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { cyclePaymentsWhere } from '@/server/services/billService';
import { syncBillEvent } from '@/server/services/billCalendarService';
import { billName, billSel, fromLabel, hasRolledOn, otherBiller } from '@/server/billIngest/common';
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
    // Same email re-sent, or a bill+receipt sharing a real invoice/confirmation,
    // as long as that bill isn't another biller's (otherBiller).
    const select = { id: true, recurrenceId: true, dueDate: true, source: true, billerKey: true } as const;
    const own = await tx.bill.findFirst({ where: { householdId, sourceMessageId: doc.messageId }, select });
    const existing =
      own ??
      (await tx.bill.findMany({ where: { householdId, reference }, select })).find((b) => !otherBiller(b, doc)) ??
      null;

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
      const update: Prisma.BillUpdateInput = rolled ? { ...data, amount: undefined, dueDate: undefined } : { ...data };

      // The same bill from the other import (Paperless and OurHomeInbox both
      // have its invoice): it takes the new details but stays that import's
      // bill. Taking it over would cut it off from where it came from:
      // OurHomeInbox would no longer hear that it was paid or deleted here,
      // nor withdraw it, and a bill deleted here could come back from it.
      if (!own && existing.source !== opts.source) {
        Object.assign(update, { source: undefined, sourceMessageId: undefined, sourceUrl: undefined, billerKey: undefined, billerEmail: undefined });
      }

      // A one-off bill's paid/unpaid follows its payments, as when it's
      // edited by hand (billService.updateBill): a corrected amount can leave
      // it owing, or settle it. Only when it has payments: one marked paid by
      // hand has nothing to go on.
      if (!existing.recurrenceId) {
        const [paid, paymentCount] = await Promise.all([
          tx.billPayment.aggregate({ where: cyclePaymentsWhere(existing), _sum: { amount: true } }),
          tx.billPayment.count({ where: { billId: existing.id } }),
        ]);
        if (paymentCount > 0) update.status = (paid._sum.amount ?? 0) + 0.005 >= amount ? 'paid' : 'unpaid';
      }

      // The payments for its due date move with a corrected due date (see
      // billService.updateBill): a recurring bill counts only those.
      if (!rolled && existing.dueDate && data.dueDate && data.dueDate.getTime() !== existing.dueDate.getTime()) {
        await tx.billPayment.updateMany({
          where: { billId: existing.id, cycleDueDate: existing.dueDate },
          data: { cycleDueDate: data.dueDate },
        });
      }

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
