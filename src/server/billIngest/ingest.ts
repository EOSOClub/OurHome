import { createHash } from 'node:crypto';
import { ingestBill } from '@/server/billIngest/bill';
import { ingestReceipt } from '@/server/billIngest/receipt';
import type { IngestOptions, IngestResult } from '@/server/billIngest/types';
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
//
// Layout: this file is the entry point; bill.ts and receipt.ts import each
// kind; matching.ts finds a receipt's bill and splits off a card fee when
// OurHome has to work that out itself (Paperless). OurHomeInbox pairs its
// payments itself (`receiptPairing: 'reference'`, see types.ts).

/**
 * The cross-document link key: a real invoice or confirmation number when the
 * email has one (so a bill and its later receipt share it), otherwise a stable
 * generated id derived from the Message-ID (unique per email - used only for
 * dedup, never cross-links).
 */
function resolveReference(doc: BillIngestInput): string {
  const real = doc.reference?.trim() || doc.invoiceNo?.trim() || doc.confirmationNo?.trim();
  if (real) return real.slice(0, 200);
  return generatedReference(doc);
}

/** The stable id made from the Message-ID: unique per email, never shared with a real bill. */
function generatedReference(doc: BillIngestInput): string {
  return 'GEN-' + createHash('sha1').update(doc.messageId).digest('hex').slice(0, 10).toUpperCase();
}

export async function ingestFinancialDoc(
  householdId: string,
  doc: BillIngestInput,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const opts: Required<IngestOptions> = {
    source: options.source ?? 'email',
    createUnmatchedReceipts: options.createUnmatchedReceipts ?? true,
    receiptPairing: options.receiptPairing ?? 'match',
  };
  // A paired import's receipt without a reference ("Paid on its own" in
  // OurHomeInbox) becomes a paid bill of its own: it gets the generated id,
  // never its invoice or confirmation number, so it can't collide with (and
  // later be updated by, or pay) a real bill. Everything else, Paperless
  // included, resolves as it always has.
  const ownPaidBill = opts.receiptPairing === 'reference' && doc.kind === 'receipt' && !doc.reference;
  const reference = ownPaidBill ? generatedReference(doc) : resolveReference(doc);

  // Statements are "your statement is available" pointers with no amount - nothing
  // actionable to record as a bill or payment.
  if (doc.kind === 'statement') {
    return { status: 'skipped', kind: doc.kind, reference, reason: 'statement' };
  }

  if (doc.kind === 'bill') {
    return ingestBill(householdId, doc, reference, opts);
  }
  return ingestReceipt(householdId, doc, reference, opts);
}
