import type { BillIngestInput } from '@/lib/validation/billIngest';

// Pure translation from a Paperless-ngx document (API v9) to the bill
// importer's input, plus the "is it ready to import?" rules. No I/O, so it is
// unit-tested directly (mapping.test.ts).
//
// Paperless does the reading: OCR, then custom fields filled by a person,
// a workflow, retitle or paperless-gpt. This only maps those fields.

/** The subset of a Paperless document the import asks for (`fields=`). */
export interface PaperlessDocument {
  id: number;
  title: string;
  correspondent: number | null;
  tags: number[];
  /** API v9: a date, "YYYY-MM-DD". */
  created: string;
  /** ISO datetime of the last change (fields, tags, title…). */
  modified: string;
  custom_fields: { field: number; value: unknown }[];
}

export type DocKind = 'bill' | 'receipt';

/** Everything resolved from Paperless once per run: ids for the names in config. */
export interface MappingContext {
  /** Tag id → what a document carrying it is. */
  kindTags: Map<number, DocKind>;
  /** Tags meaning "still being processed" (e.g. waiting in paperless-gpt review). */
  pendingTagIds: Set<number>;
  fields: {
    amount: number;
    dueDate?: number;
    accountNo?: number;
    invoiceNo?: number;
  };
  /** Correspondent id → name. */
  correspondents: Map<number, string>;
  /** Public Paperless address for "Open in Paperless" links; null = no links. */
  publicUrl: string | null;
}

export type Evaluation =
  | { ready: true; input: BillIngestInput }
  | { ready: false; reason: string };

/**
 * A monetary custom field: "USD57.39", "USD-5.00", or the legacy plain number
 * (57.39 or "57.39", no currency). Empty or malformed → null.
 */
export function parseMonetary(value: unknown): { amount: number; currency: string | null } | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { amount: value, currency: null } : null;
  }
  if (typeof value !== 'string') return null;
  const m = /^([A-Z]{3})?(-?\d+(?:\.\d{1,2})?)$/.exec(value.trim());
  if (!m) return null;
  return { amount: Number(m[2]), currency: m[1] ?? null };
}

/** A date custom field / v9 `created` ("YYYY-MM-DD") as noon local time. */
export function parseDay(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  // Noon, like dates picked in the web UI, so no timezone shifts it a day.
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fieldValue(doc: PaperlessDocument, fieldId: number | undefined): unknown {
  if (fieldId === undefined) return undefined;
  return doc.custom_fields.find((f) => f.field === fieldId)?.value;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** The stable id the importer dedupes on: one Paperless document, one key. */
export function messageIdFor(docId: number): string {
  return `paperless:${docId}`;
}

/**
 * Decides whether a document can be imported yet and, if so, builds the
 * importer input. Not ready means "look again when it changes": Paperless
 * bumps `modified` when the missing field is filled in or a review tag is
 * removed, which brings it back into the next run.
 */
export function evaluateDocument(doc: PaperlessDocument, ctx: MappingContext): Evaluation {
  const kinds = new Set(doc.tags.map((t) => ctx.kindTags.get(t)).filter((k): k is DocKind => k !== undefined));
  if (kinds.size === 0) return { ready: false, reason: 'no bill tag' };
  if (kinds.size > 1) return { ready: false, reason: 'tagged as both bill and bill payment' };
  const kind = [...kinds][0];

  if (doc.tags.some((t) => ctx.pendingTagIds.has(t))) {
    return { ready: false, reason: 'waiting for review in Paperless' };
  }

  const money = parseMonetary(fieldValue(doc, ctx.fields.amount));
  if (!money) return { ready: false, reason: 'no Amount yet' };
  if (money.amount < 0) return { ready: false, reason: 'negative Amount' };

  const created = parseDay(doc.created);
  const dueDate = kind === 'bill' ? parseDay(fieldValue(doc, ctx.fields.dueDate)) : null;
  const correspondent = doc.correspondent != null ? ctx.correspondents.get(doc.correspondent) ?? null : null;
  const base = ctx.publicUrl?.replace(/\/+$/, '');

  return {
    ready: true,
    input: {
      kind,
      messageId: messageIdFor(doc.id),
      subject: doc.title.trim() || null,
      biller: correspondent,
      billerKey: doc.correspondent != null ? `paperless-correspondent:${doc.correspondent}` : null,
      amount: money.amount,
      currency: money.currency,
      dueDate,
      paidDate: kind === 'receipt' ? created : null,
      emailDate: created,
      accountNo: text(fieldValue(doc, ctx.fields.accountNo)),
      invoiceNo: text(fieldValue(doc, ctx.fields.invoiceNo)),
      sourceUrl: base ? `${base}/documents/${doc.id}/details` : null,
    },
  };
}
