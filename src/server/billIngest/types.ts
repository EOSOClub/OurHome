import type { BillIngestInput } from '@/lib/validation/billIngest';

// The bill importer's options and results (ingest.ts is the entry point).

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
   * Only for `receiptPairing: 'match'`.
   */
  createUnmatchedReceipts?: boolean;
  /**
   * How a receipt finds the bill it pays.
   *  - 'match' (default): OurHome works it out (matching.ts): the reference,
   *    then the account number, then the biller with the amount inside the
   *    card-fee band, and splits a fee off the amount itself. The Paperless import.
   *  - 'reference': the sender already paired it (OurHomeInbox, contract v2).
   *    Linked only by `reference`, with `fee` and `baseAmount` used as sent; a
   *    reference that finds no bill, or finds one already fully paid, is
   *    skipped; a receipt with no reference becomes a paid bill on its own.
   */
  receiptPairing?: 'match' | 'reference';
}
