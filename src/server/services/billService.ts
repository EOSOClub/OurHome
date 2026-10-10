import { Prisma } from '@prisma/client';
import { getPointsSettings } from '@/server/services/pointsService';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { NotFoundError } from '@/server/services/errors';
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
// applied to the balance), so fees are intentionally excluded.
type BillStats = { paidTotal: number; paymentCount: number };
const ZERO_STATS: BillStats = { paidTotal: 0, paymentCount: 0 };

type Db = Prisma.TransactionClient | typeof prisma;

async function paymentStats(db: Db, billId: string): Promise<BillStats> {
  const agg = await db.billPayment.aggregate({
    where: { billId },
    _sum: { amount: true },
    _count: true,
  });
  return { paidTotal: agg._sum.amount ?? 0, paymentCount: agg._count };
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
): BillDTO {
  return {
    id: b.id,
    name: b.name,
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
  const [rows, paymentGroups] = await Promise.all([
    prisma.bill.findMany({ where: { householdId }, include: billInclude }),
    // One grouped query for all payment totals — avoids an aggregate per bill.
    prisma.billPayment.groupBy({
      by: ['billId'],
      where: { householdId },
      _sum: { amount: true },
      _count: true,
    }),
  ]);
  const statsByBill = new Map<string, BillStats>(
    paymentGroups
      .filter((g): g is typeof g & { billId: string } => g.billId !== null)
      .map((g) => [g.billId, { paidTotal: g._sum.amount ?? 0, paymentCount: g._count }]),
  );
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
  return rows.map((r) => billToDTO(r, statsByBill.get(r.id) ?? ZERO_STATS));
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

  const payments = await prisma.billPayment.findMany({
    where: { householdId, billId: id },
    include: paymentInclude,
    orderBy: { paidAt: 'desc' },
  });
  const paidTotal = payments.reduce((sum, p) => sum + p.amount, 0);
  const feeTotal = payments.reduce((sum, p) => sum + (p.fee ?? 0), 0);

  return {
    ...billToDTO(bill, { paidTotal, paymentCount: payments.length }),
    invoiceNo: bill.invoiceNo,
    accountNo: bill.accountNo,
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
        message: `added bill “${created.name}”`,
      },
      tx,
    );
    return created;
  });

  return billToDTO(bill);
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
      select: { id: true, recurrenceId: true, dueDate: true },
    });
    if (!existing) throw new NotFoundError(`Bill ${id} not found.`);

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
    // leave it owing (or settle it). Only when it has payments — a bill marked
    // paid by hand has nothing to recompute from — and the edit didn't set a
    // status itself.
    let status = rest.status;
    if (rest.amount !== undefined && status === undefined && !existing.recurrenceId && recurrenceId === undefined && !recurrence) {
      const { paidTotal, paymentCount } = await paymentStats(tx, id);
      if (paymentCount > 0) status = paidTotal + 0.005 >= rest.amount ? 'paid' : 'unpaid';
    }

    const updated = await tx.bill.update({
      where: { id },
      data: {
        name: rest.name?.trim(),
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

    // Keep the linked due-date calendar event (source="email") in step with the
    // bill. No-op for manually entered bills, which have no linked event.
    if (rest.dueDate !== undefined) {
      if (updated.dueDate) {
        await tx.event.updateMany({
          where: { householdId, billId: id },
          data: { startAt: updated.dueDate },
        });
      } else {
        await tx.event.deleteMany({ where: { householdId, billId: id } });
      }
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
    const stats = await paymentStats(tx, updated.id);
    return { updated, stats };
  });

  return billToDTO(bill.updated, bill.stats);
}

/**
 * Record a payment.
 *
 * Recurring bills treat each payment as clearing the current cycle: they roll
 * forward to the next due date and stay unpaid for the new cycle (payment amounts
 * accumulate across cycles, so a per-cycle "fully paid" check isn't meaningful).
 *
 * One-off bills are partial-payment aware: a payment smaller than the remaining
 * balance leaves the bill unpaid; the bill flips to "paid" only once the summed
 * payments cover its amount (cent tolerance) — matching the email-ingest logic.
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

    // Default the applied amount to what's still owed (recurring bills bill per
    // cycle, so default to the full cycle amount rather than a polluted remainder).
    const priorPaid = recurs ? 0 : (await paymentStats(tx, existing.id)).paidTotal;
    const remaining = Math.max(0, existing.amount - priorPaid);
    const amount = input.amount ?? (remaining > 0 ? remaining : existing.amount);

    await tx.billPayment.create({
      data: {
        householdId,
        billId: existing.id,
        amount,
        fee: input.fee ?? null,
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
    const stats = await paymentStats(tx, existing.id);
    return { updated, stats };
  });

  return billToDTO(result.updated, result.stats);
}

/**
 * Edit a recorded payment and recompute the linked bill's status from the new
 * totals: one-off bills flip between paid/unpaid as the summed payments cross
 * the balance (cent tolerance, same rule as markBillPaid/deletePayment).
 * Recurring bills are left as-is — their status tracks the cycle, not the totals.
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
        select: { id: true, name: true, amount: true, recurrenceId: true },
      });
      if (bill && !bill.recurrenceId) {
        const { paidTotal } = await paymentStats(tx, bill.id);
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
 * Recurring bills are left as-is — their status tracks the cycle, not the totals.
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
        select: { id: true, name: true, amount: true, recurrenceId: true },
      });
      if (bill && !bill.recurrenceId) {
        const { paidTotal } = await paymentStats(tx, bill.id);
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
