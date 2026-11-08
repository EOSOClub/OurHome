import type { Prisma } from '@prisma/client';
import { getPointsSettings } from '@/server/services/pointsService';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { cyclePaymentsWhere } from '@/server/services/billService';
import { syncBillEvent } from '@/server/services/billCalendarService';
import { nextAfterOccurrence } from '@/server/services/recurrenceService';
import { billName, billSel, fromLabel, hasRolledOn, normalizeRule, otherBiller } from '@/server/billIngest/common';
import { cents, feeCeiling, findMatchingBill, sentFee, splitFee, type MatchedBill } from '@/server/billIngest/matching';
import type { IngestOptions, IngestResult } from '@/server/billIngest/types';
import type { BillIngestInput } from '@/lib/validation/billIngest';
import { dateKey } from '@/lib/format';

// A receipt (payment) document: a payment on the bill it pays, or, when
// allowed, a new bill recorded as already paid. Which bill it pays is worked
// out here (matching.ts) or, for OurHomeInbox, sent with it as `reference`
// (`receiptPairing` in types.ts).
//
// Payments outlive a deleted bill (BillPayment.bill is onDelete: SetNull), so
// they stay as spending history. An email payment whose bill was deleted is
// attached again, not reported as a duplicate, when OurHomeInbox sends its
// bill back (after a reconnect, say); the same payment row is reused so the
// spending is never counted twice.

/**
 * True when a recurring bill has a cycle paid already whose due date is on or
 * after `paidAt`: a payment made by then was for that cycle (or an earlier
 * one), not the current one. A payment made after it, for example the next
 * month's under the same loan number, is for the current cycle.
 *
 * Also true when a paid cycle already has this very payment: the same amount
 * on the same day (in the household's zone) under the same reference, or with
 * none. A cycle paid late has a payment after its due date, so the date rule
 * alone would take a second document for it as the next cycle's payment and
 * roll the bill on again. A new month's payment is on another day.
 */
async function paidForClosedCycle(
  tx: Prisma.TransactionClient,
  bill: MatchedBill,
  paidAt: Date,
  amount: number,
  reference: string,
  timeZone: () => Promise<string>,
): Promise<boolean> {
  if (!bill.recurrenceId || !bill.dueDate) return false;
  const latest = await tx.billPayment.findFirst({
    where: { billId: bill.id, cycleDueDate: { lt: bill.dueDate } },
    orderBy: { cycleDueDate: 'desc' },
    select: { cycleDueDate: true },
  });
  if (!latest?.cycleDueDate) return false;
  if (paidAt.getTime() <= latest.cycleDueDate.getTime()) return true;

  // Two days either side covers any zone; the day itself is compared below.
  const DAY = 24 * 60 * 60 * 1000;
  const near = await tx.billPayment.findMany({
    where: {
      billId: bill.id,
      cycleDueDate: { lt: bill.dueDate },
      paidAt: { gte: new Date(paidAt.getTime() - 2 * DAY), lt: new Date(paidAt.getTime() + 2 * DAY) },
    },
    select: { amount: true, fee: true, paidAt: true, reference: true },
  });
  if (!near.length) return false;
  const zone = await timeZone();
  const day = dateKey(paidAt, zone);
  const want = cents(amount);
  // The amount as charged (with its card fee) or as applied: a payment added
  // by hand may have been entered either way. Entered by hand with no fee,
  // the charged amount on the slip is the applied one plus a card fee, as
  // much as a fee can be on this bill (feeCeiling, as when a slip is split).
  const ceiling = feeCeiling(bill.amount);
  const samePayment = (p: { amount: number; fee: number | null }) => {
    if (cents(p.amount + (p.fee ?? 0)) === want || cents(p.amount) === want) return true;
    const extra = cents(want - p.amount);
    return p.fee == null && extra > 0 && extra <= ceiling;
  };
  return near.some(
    (p) =>
      dateKey(p.paidAt, zone) === day &&
      samePayment(p) &&
      (p.reference == null || p.reference === reference),
  );
}

export async function ingestReceipt(
  householdId: string,
  doc: BillIngestInput,
  reference: string,
  opts: Required<IngestOptions>,
): Promise<IngestResult> {
  const amount = doc.amount ?? 0;
  const paidAt = doc.paidDate ?? doc.emailDate ?? new Date();
  const name = billName(doc);
  const from = fromLabel(opts.source);
  const notes = doc.subject ? `From ${from}: ${doc.subject}` : null;
  // The household's zone, looked up once and only when needed.
  let zone: Promise<string> | undefined;
  const timeZone = () => (zone ??= getPointsSettings(householdId).then((s) => s.timezone));

  return prisma.$transaction(async (tx) => {
    const paired = opts.receiptPairing === 'reference';

    // A receipt email is one payment; never apply it twice. The one exception:
    // a paired email payment left without a bill (its bill was deleted) is
    // attached again below, reusing that row, rather than skipped forever.
    const dupPayment = await tx.billPayment.findFirst({
      where: { householdId, sourceMessageId: doc.messageId },
      select: { id: true, billId: true, source: true },
    });
    const orphan = paired && dupPayment?.billId === null && dupPayment.source === 'email' ? dupPayment : null;
    if (dupPayment && !orphan) {
      return { status: 'duplicate' as const, kind: 'receipt' as const, reference, paymentId: dupPayment.id };
    }

    // Records the payment on its bill, as the email sends it now: the orphan
    // above when there is one, otherwise a new payment.
    const savePayment = (link: { billId: string; amount: number; fee: number | null; cycleDueDate: Date | null }) => {
      const fields = {
        ...link,
        paidAt,
        reference,
        confirmationNo: doc.confirmationNo ?? null,
        paidLate: doc.paidLate === true,
        notes,
      };
      return orphan
        ? tx.billPayment.update({ where: { id: orphan.id }, data: fields, select: { id: true } })
        : tx.billPayment.create({
            data: { householdId, ...fields, source: opts.source, sourceMessageId: doc.messageId },
            select: { id: true },
          });
    };

    let match: MatchedBill | null = null;
    if (paired) {
      // The sender already decided which bill this pays (OurHomeInbox): only
      // its `reference` links it. No reference means a person there marked it
      // "Paid on its own": it becomes a paid bill below.
      if (doc.reference) {
        match = await tx.bill.findFirst({
          where: { householdId, reference },
          include: { recurrence: true },
          // Deterministic if two bills ever share a reference: the newest.
          orderBy: { createdAt: 'desc' },
        });
        // Two billers' bills can share an invoice number (bill.ts keeps them
        // apart): prefer the one from this payment's biller. The biller never
        // rules a bill out here, since OurHomeInbox already paired it.
        if (match && otherBiller(match, doc)) {
          const same = await tx.bill.findMany({
            where: { householdId, reference },
            include: { recurrence: true },
            orderBy: { createdAt: 'desc' },
          });
          match = same.find((b) => !otherBiller(b, doc)) ?? match;
        }
        if (!match) {
          return { status: 'skipped' as const, kind: 'receipt' as const, reference, reason: "Its bill isn't in OurHome" };
        }
      }
    } else {
      // The strongest signal first: reference, account number, then biller with
      // the amount within the card-fee band (matching.ts).
      match = await findMatchingBill(tx, householdId, doc, reference, amount);
    }

    if (match) {
      // Only this cycle's payments: a recurring bill's earlier cycles are paid off.
      const priorAgg = await tx.billPayment.aggregate({
        where: cyclePaymentsWhere(match),
        _sum: { amount: true },
      });
      const prior = priorAgg._sum.amount ?? 0;
      const outstanding = Math.max(0, match.amount - prior);

      // A paired payment never goes on a bill that's already settled here
      // (paid by hand, say): it would count twice. A bill email is paid by at
      // most one payment, so a recurring bill that has already rolled past
      // the email's cycle (a payment recorded for another cycle) counts as
      // paid too; otherwise this would pay the next cycle and roll it again.
      //
      // A Paperless payment found by its invoice number (a second document
      // for one payment: card slip and bank confirmation, or a bill paid by
      // hand whose receipt is scanned later) gets the same check, except for
      // part payments: several can pay one invoice, each while some of it is
      // still owed. A recurring bill there can share one number every month
      // (a loan number), so it counts as paid only when this payment was made
      // on or before the due date of a cycle already paid, or when a paid
      // cycle already has the same payment (amount and day): it belongs to
      // that cycle, and would otherwise pay the next one and roll it on again.
      const byReference = !paired && match.reference === reference;
      if (
        (paired && (match.status === 'paid' || outstanding < 0.005 || (await hasRolledOn(tx, match)))) ||
        (byReference && (match.status === 'paid' || outstanding < 0.005 || (await paidForClosedCycle(tx, match, paidAt, amount, reference, timeZone))))
      ) {
        return {
          status: 'skipped' as const,
          kind: 'receipt' as const,
          reference,
          billId: match.id,
          reason: 'This bill is already paid in OurHome',
        };
      }

      const { applied, fee } = paired ? sentFee(doc, amount) : splitFee(doc, amount, outstanding, match.amount);

      const payment = await savePayment({
        billId: match.id,
        amount: applied,
        fee: fee > 0 ? fee : null,
        cycleDueDate: match.dueDate,
      });

      // Paid only once payments cover the balance - a smaller payment leaves the
      // bill unpaid (a partial payment / still behind), not falsely "paid".
      const paidTotal = prior + applied;
      const fullyPaid = paidTotal + 0.005 >= match.amount; // cent tolerance

      const rule = normalizeRule(match.recurrence, await timeZone());
      const next = rule ? nextAfterOccurrence(rule, match.dueDate) : null;
      const recurrenceEnded =
        !!match.recurrence && match.recurrence.kind !== 'cron' && next === null;

      if (fullyPaid && match.recurrence && !recurrenceEnded) {
        // Recurring bill cleared → roll forward to the next cycle, stay unpaid.
        await tx.recurrenceRule.update({ where: { id: match.recurrence.id }, data: { nextRunAt: next } });
        const rolled = await tx.bill.update({
          where: { id: match.id },
          data: { status: 'unpaid', dueDate: next ?? match.dueDate },
          select: billSel,
        });
        // Moves its calendar entry along; a bill nobody put on the calendar stays off it.
        if (await tx.event.count({ where: { householdId, billId: rolled.id } })) {
          await syncBillEvent(tx, householdId, rolled, opts.source);
        }
      } else if (fullyPaid) {
        await tx.bill.update({ where: { id: match.id }, data: { status: 'paid' } });
      } else {
        await tx.bill.update({ where: { id: match.id }, data: { status: 'unpaid' } });
      }

      await logActivity(
        {
          householdId,
          actorId: null,
          verb: fullyPaid ? 'completed' : 'updated',
          subjectType: 'bill',
          subjectId: match.id,
          message: `recorded ${fullyPaid ? 'payment' : 'partial payment'} for “${match.name}” from ${from}`,
          metadata: { applied, fee, paidTotal, balance: match.amount },
        },
        tx,
      );
      return { status: 'linked' as const, kind: 'receipt' as const, reference, billId: match.id, paymentId: payment.id };
    }

    // A paired receipt only gets here without a reference: "Paid on its own".
    if (!paired && !opts.createUnmatchedReceipts) {
      return { status: 'skipped' as const, kind: 'receipt' as const, reference, reason: 'no matching unpaid bill' };
    }

    // No matching bill: record the bill as already paid, plus its payment, so the
    // Bills tab shows what was paid (the user asked for bills and payments made
    // to be added automatically). Honor an explicit fee split so the bill's balance is the base
    // amount and the surcharge is recorded separately (not baked into the balance).
    // Whole cents, like every other money value (matching.ts cents).
    const fee = doc.fee != null ? cents(doc.fee) : null;
    const base = cents(fee != null ? (doc.baseAmount ?? Math.max(0, amount - fee)) : amount);
    const bill = await tx.bill.create({
      data: {
        householdId,
        status: 'paid',
        source: opts.source,
        name,
        amount: base,
        currency: doc.currency ?? 'USD',
        dueDate: doc.dueDate ?? null,
        reference,
        sourceMessageId: doc.messageId,
        invoiceNo: doc.invoiceNo ?? null,
        accountNo: doc.accountNo ?? null,
        confirmationNo: doc.confirmationNo ?? null,
        billerEmail: doc.billerEmail ?? null,
        billerKey: doc.billerKey ?? null,
        sourceUrl: doc.sourceUrl ?? null,
        notes,
      },
      select: { id: true, name: true },
    });
    const payment = await savePayment({ billId: bill.id, amount: base, fee, cycleDueDate: doc.dueDate ?? null });
    await logActivity(
      { householdId, actorId: null, verb: 'created', subjectType: 'bill', subjectId: bill.id, message: `recorded paid bill “${bill.name}” from ${from}`, metadata: { amount: base, fee, reference } },
      tx,
    );
    return { status: 'created' as const, kind: 'receipt' as const, reference, billId: bill.id, paymentId: payment.id };
  });
}
