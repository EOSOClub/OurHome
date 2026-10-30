import { Prisma } from '@prisma/client';
import { getPointsSettings } from '@/server/services/pointsService';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { billIdsOnCalendar, syncBillEvent } from '@/server/services/billCalendarService';
import { ConflictError, NotFoundError } from '@/server/services/errors';
import {
  nextAfterOccurrence,
  formatIntList,
  parseIntList,
  type NormalizedRule,
} from '@/server/services/recurrenceService';
import type { BillDTO, BillDetailDTO, BillPaymentDTO } from '@/lib/types';
import type { RecurrenceInput } from '@/lib/validation/task';
import type {
  CreateBillInput,
  MarkBillPaidInput,
  UpdateBillInput,
  UpdatePaymentInput,
} from '@/lib/validation/bills';

const billInclude = {
  recurrence: true,
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.BillInclude;

type BillWithRelations = Prisma.BillGetPayload<{ include: typeof billInclude }>;

// Aggregates over a bill's payments. `paidTotal` sums `amount` (the portion
// applied to the balance), so fees are intentionally excluded. It is what has
// been paid toward the CURRENT balance (see cyclePaymentsWhere); `paymentCount`
// counts every payment the bill has ever had.
type BillStats = { paidTotal: number; paymentCount: number };
const ZERO_STATS: BillStats = { paidTotal: 0, paymentCount: 0 };

type Db = Prisma.TransactionClient | typeof prisma;

type BillCycle = { id: string; recurrenceId: string | null; dueDate: Date | null };

/**
 * True when a payment counts toward the bill's current balance. A one-off bill
 * counts all its payments. A recurring bill rolls on to its next due date when
 * paid, so only payments made for its current due date count; summing them all
 * would make every recurring bill with a past payment look settled.
 */
export function countsTowardBalance(bill: BillCycle, cycleDueDate: Date | null): boolean {
  if (!bill.recurrenceId || !bill.dueDate) return true;
  return cycleDueDate?.getTime() === bill.dueDate.getTime();
}

/** The `where` for the payments that count toward the bill's current balance. */
export function cyclePaymentsWhere(bill: BillCycle): Prisma.BillPaymentWhereInput {
  if (!bill.recurrenceId || !bill.dueDate) return { billId: bill.id };
  return { billId: bill.id, cycleDueDate: bill.dueDate };
}

async function paymentStats(db: Db, bill: BillCycle): Promise<BillStats> {
  const [cycle, paymentCount] = await Promise.all([
    db.billPayment.aggregate({ where: cyclePaymentsWhere(bill), _sum: { amount: true } }),
    db.billPayment.count({ where: { billId: bill.id } }),
  ]);
  return { paidTotal: cycle._sum.amount ?? 0, paymentCount };
}

const paymentInclude = {
  paidBy: { select: { id: true, name: true } },
} satisfies Prisma.BillPaymentInclude;

type PaymentWithRelations = Prisma.BillPaymentGetPayload<{
  include: typeof paymentInclude;
}>;

function paymentToDTO(p: PaymentWithRelations): BillPaymentDTO {
  return {
    id: p.id,
    billId: p.billId,
    amount: p.amount,
    fee: p.fee ?? null,
    paidAt: p.paidAt.toISOString(),
    notes: p.notes,
    source: p.source,
    confirmationNo: p.confirmationNo,
    paidBy: p.paidBy ? { id: p.paidBy.id, name: p.paidBy.name } : null,
    createdById: p.createdById,
  };
}

function normalizeRule(r: BillWithRelations['recurrence'], timeZone?: string): NormalizedRule | null {
  if (!r) return null;
  return {
    kind: r.kind as NormalizedRule['kind'],
    interval: r.interval,
    byWeekday: parseIntList(r.byWeekday),
    byMonthday: parseIntList(r.byMonthday),
    cron: r.cron,
    anchorDate: r.anchorDate,
    until: r.until,
    // The household's zone: due dates keep their local time across DST.
    timeZone,
  };
}

function recurrenceData(recurrence: RecurrenceInput, anchor: Date) {
  return {
    kind: recurrence.kind,
    interval: recurrence.interval,
    byWeekday: formatIntList(recurrence.byWeekday),
    byMonthday: formatIntList(recurrence.byMonthday),
    cron: recurrence.cron ?? null,
    timezone: recurrence.timezone,
    anchorDate: anchor,
    until: recurrence.until ?? null,
    nextRunAt: anchor,
  };
}

export function billToDTO(
  b: BillWithRelations,
  stats: BillStats = ZERO_STATS,
  onCalendar = false,
): BillDTO {
  return {
    id: b.id,
    kind: b.kind === 'subscription' ? 'subscription' : 'bill',
    name: b.name,
    website: b.website ?? null,
    accountNo: b.accountNo ?? null,
    trialEndsAt: b.trialEndsAt?.toISOString() ?? null,
    onCalendar,
    amount: b.amount,
    currentCharges: b.currentCharges,
    currency: b.currency,
    dueDate: b.dueDate?.toISOString() ?? null,
    status: b.status,
    category: b.category,
    autoPay: b.autoPay,
    notes: b.notes,
    source: b.source,
    reference: b.reference,
    recurrence: b.recurrence
      ? {
          kind: b.recurrence.kind,
          interval: b.recurrence.interval,
          byWeekday: b.recurrence.byWeekday,
          byMonthday: b.recurrence.byMonthday,
          timezone: b.recurrence.timezone,
          until: b.recurrence.until?.toISOString() ?? null,
          nextRunAt: b.recurrence.nextRunAt?.toISOString() ?? null,
        }
      : null,
    assignee: b.assignee ? { id: b.assignee.id, name: b.assignee.name } : null,
    createdById: b.createdById,
    paidTotal: stats.paidTotal,
    paymentCount: stats.paymentCount,
  };
}

export async function listBills(householdId: string): Promise<BillDTO[]> {
  const [rows, paymentRows] = await Promise.all([
    prisma.bill.findMany({ where: { householdId }, include: billInclude }),
    // One query for all payment totals - avoids an aggregate per bill. Summed
    // here rather than with groupBy: each bill keeps only its current cycle's
    // payments, and Prisma's MongoDB engine panics grouping by a field older
    // payments don't have (cycleDueDate).
    prisma.billPayment.findMany({
      where: { householdId },
      select: { billId: true, amount: true, cycleDueDate: true },
    }),
  ]);
  const billsById = new Map(rows.map((r) => [r.id, r]));
  const statsByBill = new Map<string, BillStats>();
  for (const p of paymentRows) {
    const bill = p.billId ? billsById.get(p.billId) : undefined;
    if (!bill) continue;
    const stats = statsByBill.get(bill.id) ?? { ...ZERO_STATS };
    stats.paymentCount += 1;
    if (countsTowardBalance(bill, p.cycleDueDate)) stats.paidTotal += p.amount;
    statsByBill.set(bill.id, stats);
  }
  // Order in memory: MongoDB sorts null dates FIRST, but we want bills with no
  // due date last. Priority: status (asc) -> dueDate (asc, nulls last) -> newest.
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status < b.status ? -1 : 1;
    const ad = a.dueDate?.getTime() ?? null;
    const bd = b.dueDate?.getTime() ?? null;
    if (ad !== bd) {
      if (ad === null) return 1;
      if (bd === null) return -1;
      return ad - bd;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  const onCalendar = await billIdsOnCalendar(householdId, rows);
  return rows.map((r) => billToDTO(r, statsByBill.get(r.id) ?? ZERO_STATS, onCalendar.has(r.id)));
}

/** A single bill with its email-linkage fields, payment history, and totals. */
export async function getBillDetail(
  householdId: string,
  id: string,
): Promise<BillDetailDTO> {
  const bill = await prisma.bill.findFirst({
    where: { id, householdId },
    include: billInclude,
  });
  if (!bill) throw new NotFoundError(`Bill ${id} not found.`);

  const [payments, onCalendar] = await Promise.all([
    prisma.billPayment.findMany({
      where: { householdId, billId: id },
      include: paymentInclude,
      orderBy: { paidAt: 'desc' },
    }),
    billIdsOnCalendar(householdId, [bill]),
  ]);
  // Totals for the current balance; the history below still lists every payment.
  const current = payments.filter((p) => countsTowardBalance(bill, p.cycleDueDate));
  const paidTotal = current.reduce((sum, p) => sum + p.amount, 0);
  const feeTotal = current.reduce((sum, p) => sum + (p.fee ?? 0), 0);

  return {
    ...billToDTO(bill, { paidTotal, paymentCount: payments.length }, onCalendar.has(bill.id)),
    invoiceNo: bill.invoiceNo,
    confirmationNo: bill.confirmationNo,
    billerEmail: bill.billerEmail,
    sourceUrl: bill.sourceUrl,
    feeTotal,
    remaining: Math.max(0, bill.amount - paidTotal),
    payments: payments.map(paymentToDTO),
  };
}

async function validAssignee(
  householdId: string,
  userId: string | null | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const member = await prisma.user.findFirst({
    where: { id: userId, householdId },
    select: { id: true },
  });
  return member?.id ?? null;
}

export async function createBill(
  householdId: string,
  userId: string,
  input: CreateBillInput,
): Promise<BillDTO> {
  const assignedUserId = await validAssignee(householdId, input.assignedUserId);

  const bill = await prisma.$transaction(async (tx) => {
    let recurrenceId: string | undefined;
    if (input.recurrence) {
      const rule = await tx.recurrenceRule.create({
        data: recurrenceData(input.recurrence, input.dueDate ?? new Date()),
      });
      recurrenceId = rule.id;
    }
    const created = await tx.bill.create({
      data: {
        householdId,
        kind: input.kind,
        website: input.website ?? null,
        accountNo: input.accountNo ?? null,
        trialEndsAt: input.kind === 'subscription' ? (input.trialEndsAt ?? null) : null,
        name: input.name.trim(),
        amount: input.amount,
        // Omitted ⇒ the schema default ("USD") applies.
        currency: input.currency ?? undefined,
        dueDate: input.dueDate ?? null,
        category: input.category ?? null,
        autoPay: input.autoPay,
        notes: input.notes ?? null,
        source: 'manual',
        recurrenceId,
        assignedUserId,
        createdById: userId,
      },
      include: billInclude,
    });
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'created',
        subjectType: 'bill',
        subjectId: created.id,
        message: `added ${created.kind === 'subscription' ? 'subscription' : 'bill'} “${created.name}”`,
      },
      tx,
    );
    // Made on the calendar: on the calendar from the start.
    const onCalendar = !!input.onCalendar && !!(await syncBillEvent(tx, householdId, created, 'manual'));
    return { created, onCalendar };
  });

  return billToDTO(bill.created, ZERO_STATS, bill.onCalendar);
}

export async function updateBill(
  householdId: string,
  userId: string,
  input: UpdateBillInput,
): Promise<BillDTO> {
  const { id, recurrence, assignedUserId, ...rest } = input;

  const bill = await prisma.$transaction(async (tx) => {
    const existing = await tx.bill.findFirst({
      where: { id, householdId },
      select: { id: true, recurrenceId: true, dueDate: true, kind: true },
    });
    if (!existing) throw new NotFoundError(`Bill ${id} not found.`);
    // Only a subscription has a free trial; one switched to a bill loses it.
    const kind = rest.kind ?? existing.kind;
    if (kind !== 'subscription' && rest.trialEndsAt) {
      throw new ConflictError('Only a subscription has a free trial.', 'trialEndsAt');
    }

    let recurrenceId: string | null | undefined;
    if (recurrence === null) {
      recurrenceId = null;
    } else if (recurrence) {
      const anchor = rest.dueDate ?? existing.dueDate ?? new Date();
      const data = recurrenceData(recurrence, anchor);
      if (existing.recurrenceId) {
        await tx.recurrenceRule.update({ where: { id: existing.recurrenceId }, data });
      } else {
        const rule = await tx.recurrenceRule.create({ data });
        recurrenceId = rule.id;
      }
    }

    const resolvedAssignee =
      assignedUserId === undefined
        ? undefined
        : await validAssignee(householdId, assignedUserId);

    // A one-off bill's paid/unpaid follows its payments: a new amount can
    // leave it owing (or settle it). Only when it has payments - a bill marked
    // paid by hand has nothing to recompute from - and the edit didn't set a
    // status itself.
    let status = rest.status;
    if (rest.amount !== undefined && status === undefined && !existing.recurrenceId && recurrenceId === undefined && !recurrence) {
      const { paidTotal, paymentCount } = await paymentStats(tx, existing);
      if (paymentCount > 0) status = paidTotal + 0.005 >= rest.amount ? 'paid' : 'unpaid';
    }

    const updated = await tx.bill.update({
      where: { id },
      data: {
        name: rest.name?.trim(),
        kind: rest.kind,
        website: rest.website,
        accountNo: rest.accountNo,
        trialEndsAt: kind === 'subscription' ? rest.trialEndsAt : null,
        amount: rest.amount,
        dueDate: rest.dueDate,
        status,
        category: rest.category,
        autoPay: rest.autoPay,
        notes: rest.notes,
        assignedUserId: resolvedAssignee,
        recurrenceId,
      },
      include: billInclude,
    });

    if (recurrence === null && existing.recurrenceId) {
      await tx.recurrenceRule.delete({ where: { id: existing.recurrenceId } });
    }

    // Keep the bill's calendar entry (if it has one) in step: its date, and
    // its title and amount when those changed. No date takes it off.
    const onCalendar = (await tx.event.count({ where: { householdId, billId: id } })) > 0;
    if (onCalendar) {
      if (updated.dueDate) await syncBillEvent(tx, householdId, updated, 'manual');
      else await tx.event.deleteMany({ where: { householdId, billId: id } });
    }

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'updated',
        subjectType: 'bill',
        subjectId: updated.id,
        message: `updated bill “${updated.name}”`,
      },
      tx,
    );
    const stats = await paymentStats(tx, updated);
    return { updated, stats };
  });

  const onCalendar = await billIdsOnCalendar(householdId, [bill.updated]);
  return billToDTO(bill.updated, bill.stats, onCalendar.has(id));
}

/**
 * Record a payment.
 *
 * Recurring bills treat each payment as clearing the current cycle: they roll
 * forward to the next due date and stay unpaid for the new cycle. Each payment
 * records the due date it paid (`cycleDueDate`), so the balance only ever counts
 * the current cycle's payments.
 *
 * One-off bills are partial-payment aware: a payment smaller than the remaining
 * balance leaves the bill unpaid; the bill flips to "paid" only once the summed
 * payments cover its amount (cent tolerance) - matching the email-ingest logic.
 * `amount` defaults to the remaining balance, and an optional `fee` records a card
 * surcharge without counting toward the balance.
 */
export async function markBillPaid(
  householdId: string,
  userId: string,
  input: MarkBillPaidInput,
): Promise<BillDTO> {
  const { timezone: timeZone } = await getPointsSettings(householdId);
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.bill.findFirst({
      where: { id: input.id, householdId },
      include: { recurrence: true },
    });
    if (!existing) throw new NotFoundError(`Bill ${input.id} not found.`);

    const rule = normalizeRule(existing.recurrence, timeZone);
    const next = rule ? nextAfterOccurrence(rule, existing.dueDate) : null;
    const recurrenceEnded =
      !!existing.recurrence && existing.recurrence.kind !== 'cron' && next === null;
    const recurs = !!existing.recurrence && !recurrenceEnded;

    // Default the applied amount to what's still owed this cycle (a Paperless
    // import can leave part of a recurring bill's cycle paid).
    const priorPaid = (await paymentStats(tx, existing)).paidTotal;
    const remaining = Math.max(0, existing.amount - priorPaid);
    const amount = input.amount ?? (remaining > 0 ? remaining : existing.amount);

    await tx.billPayment.create({
      data: {
        householdId,
        billId: existing.id,
        amount,
        fee: input.fee ?? null,
        cycleDueDate: existing.dueDate,
        paidByUserId: userId,
        createdById: userId,
        paidAt: input.paidAt ?? new Date(),
        notes: input.note ?? null,
        source: 'manual',
      },
    });

    const fullyPaid = recurs || priorPaid + amount + 0.005 >= existing.amount;

    let updated: BillWithRelations;
    if (recurs) {
      await tx.recurrenceRule.update({
        where: { id: existing.recurrence!.id },
        data: { nextRunAt: next },
      });
      updated = await tx.bill.update({
        where: { id: existing.id },
        data: { status: 'unpaid', dueDate: next ?? existing.dueDate },
        include: billInclude,
      });
      // Move the linked due-date calendar event forward with the bill.
      if (next) {
        await tx.event.updateMany({
          where: { householdId, billId: existing.id },
          data: { startAt: next },
        });
      }
    } else {
      updated = await tx.bill.update({
        where: { id: existing.id },
        data: { status: fullyPaid ? 'paid' : 'unpaid' },
        include: billInclude,
      });
    }

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: fullyPaid ? 'completed' : 'updated',
        subjectType: 'bill',
        subjectId: existing.id,
        message: fullyPaid
          ? `paid bill “${existing.name}”`
          : `recorded partial payment for “${existing.name}”`,
        metadata: { amount, fee: input.fee ?? 0 },
      },
      tx,
    );
    const stats = await paymentStats(tx, updated);
    return { updated, stats };
  });

  return billToDTO(result.updated, result.stats);
}

/**
 * Edit a recorded payment and recompute the linked bill's status from the new
 * totals: one-off bills flip between paid/unpaid as the summed payments cross
 * the balance (cent tolerance, same rule as markBillPaid/deletePayment).
 * Recurring bills are left as-is - their status tracks the cycle, not the totals.
 */
export async function updatePayment(
  householdId: string,
  userId: string,
  input: UpdatePaymentInput,
): Promise<BillPaymentDTO> {
  const payment = await prisma.$transaction(async (tx) => {
    const existing = await tx.billPayment.findFirst({
      where: { id: input.id, householdId },
      select: { id: true, billId: true },
    });
    if (!existing) throw new NotFoundError(`Payment ${input.id} not found.`);

    const updated = await tx.billPayment.update({
      where: { id: existing.id },
      data: {
        amount: input.amount,
        fee: input.fee,
        paidAt: input.paidAt,
        notes: input.notes,
        confirmationNo: input.confirmationNo,
      },
      include: paymentInclude,
    });

    if (existing.billId) {
      const bill = await tx.bill.findUnique({
        where: { id: existing.billId },
        select: { id: true, name: true, amount: true, recurrenceId: true, dueDate: true },
      });
      if (bill && !bill.recurrenceId) {
        const { paidTotal } = await paymentStats(tx, bill);
        const fullyPaid = paidTotal + 0.005 >= bill.amount;
        await tx.bill.update({
          where: { id: bill.id },
          data: { status: fullyPaid ? 'paid' : 'unpaid' },
        });
      }
      await logActivity(
        {
          householdId,
          actorId: userId,
          verb: 'updated',
          subjectType: 'bill',
          subjectId: existing.billId,
          message: `updated a payment on “${bill?.name ?? 'bill'}”`,
          metadata: { amount: updated.amount, fee: updated.fee ?? 0 },
        },
        tx,
      );
    }
    return updated;
  });

  return paymentToDTO(payment);
}

/**
 * Delete a recorded payment and recompute the linked bill's status (one-off bills
 * revert to unpaid if the remaining payments no longer cover the balance).
 * Recurring bills are left as-is - their status tracks the cycle, not the totals.
 */
export async function deletePayment(
  householdId: string,
  userId: string,
  paymentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.billPayment.findFirst({
      where: { id: paymentId, householdId },
      select: { id: true, billId: true },
    });
    if (!payment) throw new NotFoundError(`Payment ${paymentId} not found.`);

    await tx.billPayment.delete({ where: { id: payment.id } });

    if (payment.billId) {
      const bill = await tx.bill.findUnique({
        where: { id: payment.billId },
        select: { id: true, name: true, amount: true, recurrenceId: true, dueDate: true },
      });
      if (bill && !bill.recurrenceId) {
        const { paidTotal } = await paymentStats(tx, bill);
        const fullyPaid = paidTotal + 0.005 >= bill.amount;
        await tx.bill.update({
          where: { id: bill.id },
          data: { status: fullyPaid ? 'paid' : 'unpaid' },
        });
      }
      await logActivity(
        {
          householdId,
          actorId: userId,
          verb: 'updated',
          subjectType: 'bill',
          subjectId: payment.billId,
          message: `removed a payment from “${bill?.name ?? 'bill'}”`,
        },
        tx,
      );
    }
  });
}

export async function deleteBill(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await tx.bill.findFirst({
      where: { id, householdId },
      select: { id: true, name: true, recurrenceId: true },
    });
    if (!existing) throw new NotFoundError(`Bill ${id} not found.`);

    await tx.bill.delete({ where: { id: existing.id } });
    if (existing.recurrenceId) {
      await tx.recurrenceRule.delete({ where: { id: existing.recurrenceId } });
    }
    // Remove the auto-created due-date calendar event, if any (source="email").
    await tx.event.deleteMany({ where: { householdId, billId: existing.id } });
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'deleted',
        subjectType: 'bill',
        subjectId: existing.id,
        message: `deleted bill “${existing.name}”`,
      },
      tx,
    );
  });
}
