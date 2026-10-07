import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import {
  computeNextRunAt,
  parseIntList,
  type NormalizedRule,
} from '@/server/services/recurrenceService';
import type { BillIngestInput } from '@/lib/validation/billIngest';

// Ingests a single financial document from an external bill importer (one email
// or Paperless document = one document) into the household DB as a Bill /
// BillPayment / linked calendar Event. This is the only writer for
// source="email" and source="paperless" records; it owns dedup and the
// cross-document linking the parser's `reference` enables.
//
// Idempotent: re-posting the same document is a no-op (bills update in place,
// keyed on `messageId`; payments are deduped on it). A receipt that shares a
// real invoice/confirmation number with a bill attaches to that bill instead of
// creating a duplicate.

export type IngestStatus =
  | 'created'
  | 'updated'
  | 'linked'
  | 'duplicate'
  | 'skipped';

export interface IngestResult {
  status: IngestStatus;
  kind: BillIngestInput['kind'];
  reference: string;
  billId?: string;
  paymentId?: string;
  eventId?: string;
  /** Why a document was skipped, for the importer's status report. */
  reason?: string;
}

export interface IngestOptions {
  /** Stored as the bill/payment/event `source`. */
  source?: 'email' | 'paperless';
  /**
   * A receipt matching no bill normally becomes a new, already-paid bill. The
   * Paperless import turns this off: there, only documents tagged as bill
   * payments come in, and one with no bill to pay is reported, not invented.
   */
  createUnmatchedReceipts?: boolean;
}

/** "from email" / "from Paperless", for activity messages and notes. */
function fromLabel(source: IngestOptions['source']): string {
  return source === 'paperless' ? 'Paperless' : 'email';
}

const NAME_MAX = 160;

// Plausible card/convenience-fee band, used to (a) accept a biller+timing match
// whose amount differs from its bill only by a surcharge, and (b) split a
// receipt's charged amount into applied-to-balance vs. fee so the bill still
// reads as paid in full. Tune these from real receipts (see Phase 5).
const FEE_MAX_PCT = 0.04;
const FEE_MAX_FLAT = 6;

/** Upper bound on a plausible fee for a bill of the given balance. */
function feeCeiling(billAmount: number): number {
  return Math.max(FEE_MAX_FLAT, billAmount * FEE_MAX_PCT);
}

/** Strip forwarding/reply prefixes so a forwarded bill gets a clean label. */
function cleanSubject(subject: string | null | undefined): string {
  let s = (subject ?? '').trim();
  // Drop any run of leading "Fwd:" / "Fw:" / "Re:" markers.
  while (/^(fwd?|re)\s*:/i.test(s)) s = s.replace(/^(fwd?|re)\s*:/i, '').trim();
  return s;
}

/** Best display name for the bill: cleaned subject, else biller, else fallback. */
function billName(doc: BillIngestInput): string {
  const name =
    cleanSubject(doc.subject) || doc.biller?.trim() || doc.billerEmail?.trim();
  return (name || 'Bill (email)').slice(0, NAME_MAX);
}

/**
 * The cross-document link key: a real invoice or confirmation number when the
 * email has one (so a bill and its later receipt share it), otherwise a stable
 * generated id derived from the Message-ID (unique per email — used only for
 * dedup, never cross-links).
 */
function resolveReference(doc: BillIngestInput): string {
  const real = doc.reference?.trim() || doc.invoiceNo?.trim() || doc.confirmationNo?.trim();
  if (real) return real.slice(0, 200);
  return 'GEN-' + createHash('sha1').update(doc.messageId).digest('hex').slice(0, 10).toUpperCase();
}

function normalizeRule(
  r: { kind: string; interval: number; byWeekday: string | null; byMonthday: string | null; cron: string | null; anchorDate: Date; until: Date | null } | null,
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
  };
}

type Tx = Prisma.TransactionClient;

/** Create or move the bill's due-date calendar event. Keyed on billId. */
async function syncBillEvent(
  tx: Tx,
  householdId: string,
  bill: { id: string; name: string; reference: string | null; dueDate: Date | null; amount: number; currency: string | null },
  source: string = 'email',
): Promise<string | undefined> {
  if (!bill.dueDate) return undefined;
  const title = `Bill due: ${bill.name}`.slice(0, 200);
  const description = `${bill.currency ?? 'USD'} ${bill.amount.toFixed(2)} due`;
  const existing = await tx.event.findFirst({
    where: { householdId, billId: bill.id },
    select: { id: true },
  });
  if (existing) {
    await tx.event.update({
      where: { id: existing.id },
      data: { title, description, startAt: bill.dueDate, allDay: true, sourceRef: bill.reference },
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
      source,
      sourceRef: bill.reference,
      billId: bill.id,
    },
    select: { id: true },
  });
  return created.id;
}

export async function ingestFinancialDoc(
  householdId: string,
  doc: BillIngestInput,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const reference = resolveReference(doc);
  const opts: Required<IngestOptions> = {
    source: options.source ?? 'email',
    createUnmatchedReceipts: options.createUnmatchedReceipts ?? true,
  };

  // Statements are "your statement is available" pointers with no amount — nothing
  // actionable to record as a bill or payment.
  if (doc.kind === 'statement') {
    return { status: 'skipped', kind: doc.kind, reference, reason: 'statement' };
  }

  if (doc.kind === 'bill') {
    return ingestBill(householdId, doc, reference, opts);
  }
  return ingestReceipt(householdId, doc, reference, opts);
}

async function ingestBill(
  householdId: string,
  doc: BillIngestInput,
  reference: string,
  opts: Required<IngestOptions>,
): Promise<IngestResult> {
  const name = billName(doc);
  const from = fromLabel(opts.source);
  // What's owed by the due date is the total/balance. When a statement carries both
  // a balance (`totalDue`) and this period's charges (`amount`, e.g. a utility), the
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
      select: { id: true },
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
      const bill = await tx.bill.update({ where: { id: existing.id }, data, select: billSel });
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

const billSel = {
  id: true,
  name: true,
  reference: true,
  dueDate: true,
  amount: true,
  currency: true,
} satisfies Prisma.BillSelect;

async function ingestReceipt(
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

  return prisma.$transaction(async (tx) => {
    // A receipt email is one payment; never apply it twice.
    const dupPayment = await tx.billPayment.findFirst({
      where: { householdId, sourceMessageId: doc.messageId },
      select: { id: true },
    });
    if (dupPayment) {
      return { status: 'duplicate' as const, kind: 'receipt' as const, reference, paymentId: dupPayment.id };
    }

    // Match to an existing bill, strongest signal first:
    //   1. a shared real invoice/confirmation number (reference),
    //   2. the same account number — a strong identifier; amounts may legitimately
    //      differ (partial payments, or a payment toward a past-due balance),
    //   3. biller + timing: the newest still-unpaid bill from the same biller
    //      whose amount matches within a card-fee band. This is the "the next
    //      receipt from a biller pays that biller's bill" case, where the receipt
    //      shares no reference/account and its amount differs only by the fee.
    //      The biller is `billerKey` when the importer has one (Paperless
    //      correspondent), else the sender's email.
    let match = await tx.bill.findFirst({
      where: { householdId, reference },
      include: { recurrence: true },
    });
    if (!match && doc.accountNo) {
      // Only open bills — a payment clears what's still owed. (Ordering by status
      // here is a trap: "paid" sorts before "unpaid", which would misroute the
      // payment onto an already-settled bill sharing the account number.)
      match = await tx.bill.findFirst({
        where: { householdId, accountNo: doc.accountNo, status: 'unpaid' },
        include: { recurrence: true },
        orderBy: { createdAt: 'desc' }, // most recently issued open bill
      });
    }
    const biller: Prisma.BillWhereInput | null = doc.billerKey
      ? { billerKey: doc.billerKey }
      : doc.billerEmail
        ? { billerEmail: doc.billerEmail }
        : null;
    if (!match && biller) {
      // Newest-first so a receipt clears the most recently issued open bill; the
      // amount-band filter guards against linking an unrelated bill from the same
      // biller (a wildly different amount falls through to "create a paid bill").
      const candidates = await tx.bill.findMany({
        where: { householdId, ...biller, status: 'unpaid' },
        include: { recurrence: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      match =
        candidates.find(
          (c) =>
            amount >= c.amount - 0.005 &&
            amount <= c.amount + feeCeiling(c.amount) + 0.005,
        ) ?? null;
    }

    if (match) {
      // Split the charged amount into what's applied to the balance vs. a card
      // fee. Prefer an explicit split from the parser; otherwise infer the fee
      // from any overage within the fee band so the bill still reads paid in full.
      const priorAgg = await tx.billPayment.aggregate({
        where: { billId: match.id },
        _sum: { amount: true },
      });
      const prior = priorAgg._sum.amount ?? 0;
      const outstanding = Math.max(0, match.amount - prior);

      let applied: number;
      let fee: number;
      if (doc.fee != null) {
        fee = doc.fee;
        applied = doc.baseAmount ?? Math.max(0, amount - fee);
      } else if (amount > outstanding && amount - outstanding <= feeCeiling(match.amount) + 0.005) {
        applied = outstanding;
        fee = amount - outstanding;
      } else {
        applied = amount;
        fee = 0;
      }

      const payment = await tx.billPayment.create({
        data: {
          householdId,
          billId: match.id,
          amount: applied,
          fee: fee > 0 ? fee : null,
          paidAt,
          source: opts.source,
          reference,
          confirmationNo: doc.confirmationNo ?? null,
          sourceMessageId: doc.messageId,
          notes,
        },
        select: { id: true },
      });

      // Paid only once payments cover the balance — a smaller payment leaves the
      // bill unpaid (a partial payment / still behind), not falsely "paid".
      const paidTotal = prior + applied;
      const fullyPaid = paidTotal + 0.005 >= match.amount; // cent tolerance

      const rule = normalizeRule(match.recurrence);
      const next = rule ? computeNextRunAt(rule, new Date()) : null;
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
        await syncBillEvent(tx, householdId, rolled, opts.source);
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

    if (!opts.createUnmatchedReceipts) {
      return { status: 'skipped' as const, kind: 'receipt' as const, reference, reason: 'no matching unpaid bill' };
    }

    // No matching bill: record the bill as already paid, plus its payment, so the
    // Bills tab shows what was paid (the user's "automatically add bills and
    // payments made"). Honor an explicit fee split so the bill's balance is the base
    // amount and the surcharge is recorded separately (not baked into the balance).
    const fee = doc.fee ?? null;
    const base = fee != null ? (doc.baseAmount ?? Math.max(0, amount - fee)) : amount;
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
    const payment = await tx.billPayment.create({
      data: {
        householdId,
        billId: bill.id,
        amount: base,
        fee,
        paidAt,
        source: opts.source,
        reference,
        confirmationNo: doc.confirmationNo ?? null,
        sourceMessageId: doc.messageId,
        notes,
      },
      select: { id: true },
    });
    await logActivity(
      { householdId, actorId: null, verb: 'created', subjectType: 'bill', subjectId: bill.id, message: `recorded paid bill “${bill.name}” from ${from}`, metadata: { amount: base, fee, reference } },
      tx,
    );
    return { status: 'created' as const, kind: 'receipt' as const, reference, billId: bill.id, paymentId: payment.id };
  });
}
