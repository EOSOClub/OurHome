import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { getPointsSettings } from '@/server/services/pointsService';
import { logActivity } from '@/server/services/activityService';
import { ConflictError, NotFoundError } from '@/server/services/errors';
import { dateKey } from '@/lib/format';

// A bill on the calendar: one all-day Event linked by `billId`, on the bill's
// due date. billService keeps it in step (a new due date, paying a repeating
// bill, deleting the bill); a bill is only on the calendar once someone puts
// it there, or when it came in by email or Paperless (billIngestService).

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

type LinkedBill = {
  id: string;
  name: string;
  reference: string | null;
  dueDate: Date | null;
  amount: number;
  currency: string | null;
  kind?: string | null;
};

/** "Bill due: Electric", or "Netflix renews" for a subscription. */
export function billEventTitle(bill: { name: string; kind?: string | null }): string {
  const title = bill.kind === 'subscription' ? `${bill.name} renews` : `Bill due: ${bill.name}`;
  return title.slice(0, 200);
}

/** Create or move the bill's due-date calendar event. Keyed on billId. */
export async function syncBillEvent(
  tx: Tx,
  householdId: string,
  bill: LinkedBill,
  source: string = 'email',
): Promise<string | undefined> {
  if (!bill.dueDate) return undefined;
  const title = billEventTitle(bill);
  const description = `${bill.currency ?? 'USD'} ${bill.amount.toFixed(2)} due`;
  const kind = bill.kind === 'subscription' ? 'subscription' : 'bill';
  const existing = await tx.event.findFirst({
    where: { householdId, billId: bill.id },
    select: { id: true },
  });
  if (existing) {
    await tx.event.update({
      where: { id: existing.id },
      data: { title, description, startAt: bill.dueDate, allDay: true, sourceRef: bill.reference, kind },
    });
    return existing.id;
  }
  const created = await tx.event.create({
    data: {
      householdId,
      title,
      description,
      startAt: bill.dueDate,
      allDay: true,
      kind,
      source,
      sourceRef: bill.reference,
      billId: bill.id,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * Copies made by the bill page's old "Add to calendar" button: an all-day
 * event named exactly like the bill, on its due day (household zone), linked
 * to nothing. They count as the bill being on the calendar.
 */
function oldCopiesOf(
  bill: { name: string; dueDate: Date | null },
  events: { id: string; title: string; startAt: Date; billId: string | null }[],
  timeZone: string,
) {
  if (!bill.dueDate) return [];
  const day = dateKey(bill.dueDate, timeZone);
  return events.filter(
    (e) => !e.billId && e.title === bill.name && dateKey(e.startAt, timeZone) === day,
  );
}

/** Same-named all-day events, for oldCopiesOf. */
function candidateCopies(db: Db, householdId: string, names: string[]) {
  return db.event.findMany({
    // billId is checked in code: an unset field isn't `null` to MongoDB.
    where: { householdId, allDay: true, title: { in: names } },
    select: { id: true, title: true, startAt: true, billId: true },
  });
}

/** The ids of the bills that are on the calendar. */
export async function billIdsOnCalendar(
  householdId: string,
  bills: { id: string; name: string; dueDate: Date | null }[],
  db: Db = prisma,
): Promise<Set<string>> {
  if (bills.length === 0) return new Set();
  const [linked, copies, { timezone }] = await Promise.all([
    db.event.findMany({
      where: { householdId, billId: { in: bills.map((b) => b.id) } },
      select: { billId: true },
    }),
    candidateCopies(db, householdId, [...new Set(bills.map((b) => b.name))]),
    getPointsSettings(householdId),
  ]);
  const on = new Set(linked.map((e) => e.billId!));
  for (const b of bills) {
    if (!on.has(b.id) && oldCopiesOf(b, copies, timezone).length > 0) on.add(b.id);
  }
  return on;
}

async function findBill(tx: Tx, householdId: string, id: string) {
  const bill = await tx.bill.findFirst({ where: { id, householdId } });
  if (!bill) throw new NotFoundError(`Bill ${id} not found.`);
  return bill;
}

/**
 * Put a bill on the calendar, on its due date. An old copy of it is taken
 * over (linked) rather than added a second time; already on it, nothing changes.
 */
export async function addBillToCalendar(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  const { timezone } = await getPointsSettings(householdId);
  await prisma.$transaction(async (tx) => {
    const bill = await findBill(tx, householdId, id);
    if (!bill.dueDate) {
      throw new ConflictError('Give the bill a due date first.', 'dueDate');
    }
    const linked = await tx.event.findFirst({ where: { householdId, billId: id }, select: { id: true } });
    if (linked) return;
    const [copy] = oldCopiesOf(bill, await candidateCopies(tx, householdId, [bill.name]), timezone);
    if (copy) await tx.event.update({ where: { id: copy.id }, data: { billId: id } });
    await syncBillEvent(tx, householdId, bill, 'manual');
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'updated',
        subjectType: 'bill',
        subjectId: id,
        message: `put bill “${bill.name}” on the calendar`,
      },
      tx,
    );
  });
}

/** Take a bill off the calendar: its linked entry, and any old copy of it. */
export async function removeBillFromCalendar(
  householdId: string,
  userId: string,
  id: string,
): Promise<void> {
  const { timezone } = await getPointsSettings(householdId);
  await prisma.$transaction(async (tx) => {
    const bill = await findBill(tx, householdId, id);
    const copies = oldCopiesOf(bill, await candidateCopies(tx, householdId, [bill.name]), timezone);
    await tx.event.deleteMany({
      where: {
        householdId,
        OR: [{ billId: id }, ...(copies.length ? [{ id: { in: copies.map((c) => c.id) } }] : [])],
      },
    });
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'updated',
        subjectType: 'bill',
        subjectId: id,
        message: `took bill “${bill.name}” off the calendar`,
      },
      tx,
    );
  });
}
