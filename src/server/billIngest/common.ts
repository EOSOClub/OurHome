import { Prisma } from '@prisma/client';
import { parseIntList, type NormalizedRule } from '@/server/services/recurrenceService';
import type { BillIngestInput } from '@/lib/validation/billIngest';
import type { IngestOptions } from '@/server/billIngest/types';

// Small helpers shared by the bill and receipt imports.

/** "from email" / "from Paperless", for activity messages and notes. */
export function fromLabel(source: IngestOptions['source']): string {
  return source === 'paperless' ? 'Paperless' : 'email';
}

const NAME_MAX = 160;

/** Strip forwarding/reply prefixes so a forwarded bill gets a clean label. */
function cleanSubject(subject: string | null | undefined): string {
  let s = (subject ?? '').trim();
  // Drop any run of leading "Fwd:" / "Fw:" / "Re:" markers.
  while (/^(fwd?|re)\s*:/i.test(s)) s = s.replace(/^(fwd?|re)\s*:/i, '').trim();
  return s;
}

/** Best display name for the bill: cleaned subject, else biller, else fallback. */
export function billName(doc: BillIngestInput): string {
  const name =
    cleanSubject(doc.subject) || doc.biller?.trim() || doc.billerEmail?.trim();
  return (name || 'Bill (email)').slice(0, NAME_MAX);
}

export function normalizeRule(
  r: { kind: string; interval: number; byWeekday: string | null; byMonthday: string | null; cron: string | null; anchorDate: Date; until: Date | null } | null,
  timeZone?: string,
): NormalizedRule | null {
  if (!r) return null;
  return {
    kind: r.kind as NormalizedRule['kind'],
    interval: r.interval,
    byWeekday: parseIntList(r.byWeekday),
    byMonthday: parseIntList(r.byMonthday),
    cron: r.cron,
    anchorDate: r.anchorDate,
    until: r.until,
    timeZone,
  };
}

/**
 * True when a recurring bill has rolled on at least once: it has a payment
 * for a cycle other than its current due date. Counted as all its payments
 * less this cycle's, so payments recorded before `cycleDueDate` existed (null
 * or missing there) count as another cycle too. Used by both imports: a bill
 * document offered again leaves a rolled bill's due date and amount alone
 * (bill.ts), and a paired payment doesn't pay a rolled bill again (receipt.ts).
 */
export async function hasRolledOn(
  tx: Prisma.TransactionClient,
  bill: { id: string; recurrenceId: string | null; dueDate: Date | null },
): Promise<boolean> {
  if (!bill.recurrenceId || !bill.dueDate) return false;
  const [all, thisCycle] = await Promise.all([
    tx.billPayment.count({ where: { billId: bill.id } }),
    tx.billPayment.count({ where: { billId: bill.id, cycleDueDate: bill.dueDate } }),
  ]);
  return all > thisCycle;
}

/**
 * True when a bill found by its reference is plainly another biller's than
 * the document's. Invoice numbers are only unique per biller (small billers
 * count 1001, 1002...), so another biller's bill with the same number is not
 * this document's bill. Only billerKeys from the same import compare (a
 * Paperless correspondent and an OurHomeInbox biller can't), so the same
 * invoice arriving through both imports still finds its one bill. A biller
 * unknown on either side is no conflict.
 */
export function otherBiller(
  bill: { billerKey?: string | null },
  doc: Pick<BillIngestInput, 'billerKey'>,
): boolean {
  // "paperless-correspondent:4" -> "paperless-correspondent:"
  const importOf = (key: string) => key.slice(0, key.lastIndexOf(':') + 1);
  if (!bill.billerKey || !doc.billerKey) return false;
  return importOf(bill.billerKey) === importOf(doc.billerKey) && bill.billerKey !== doc.billerKey;
}

export const billSel = {
  id: true,
  name: true,
  reference: true,
  dueDate: true,
  amount: true,
  currency: true,
  kind: true,
} satisfies Prisma.BillSelect;
