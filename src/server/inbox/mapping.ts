import { z } from 'zod';
import { billIngestSchema, type BillIngestInput } from '@/lib/validation/billIngest';
import { parseDay } from '@/server/paperless/mapping';

// Pure checks of what OurHomeInbox's hand-off API sends, and the translation
// of each document into the bill importer's input. No I/O, so it is
// unit-tested directly (mapping.test.ts). The contract is in
// docs/ourhomeinbox-import.md.
//
// OurHomeInbox does the reading (it picks the amount, dates and numbers out
// of each email, and a person checks them there). This only checks the shape
// and hands the document on. Since contract v2 that includes how a payment
// pairs with its bill: `reference` (the bill's), `fee`, `baseAmount` and
// `paidLate`, all fields of billIngestSchema, so they pass straight through.

const count = z.number().int().nonnegative();

export const helloSchema = z.object({
  household: z.string().trim().min(1).max(200),
  newest: count,
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type InboxHello = z.infer<typeof helloSchema>;

/** Every entry carries these; without them nothing about it can be trusted. */
const entryBase = z.object({
  number: z.number().int().positive(),
  captureId: z.string().trim().min(1).max(500),
  status: z.enum(['ready', 'withdrawn']),
});

const readyEntry = entryBase.extend({
  status: z.literal('ready'),
  // A path on OurHomeInbox ("/mail/..."), never another site: "//host" is refused.
  link: z.string().max(500).regex(/^\/(?![/\\])/),
  document: z.record(z.string(), z.unknown()),
});

const withdrawnEntry = entryBase.extend({
  status: z.literal('withdrawn'),
  messageId: z.string().trim().min(1).max(998),
  reason: z.string().trim().max(500).optional().default(''),
});

const replySchema = z.object({
  documents: z.array(z.unknown()).max(200),
  next: count,
  more: z.boolean(),
});

export type InboxEntry =
  | {
      status: 'ready';
      number: number;
      captureId: string;
      /** For the skipped list: the email's subject, else its biller, else its id. */
      title: string;
      /** null when OurHomeInbox sent a document OurHome can't read (`problem` says why). */
      input: BillIngestInput | null;
      problem: string | null;
      /** Where the email opens in OurHomeInbox; null without a public address. */
      url: string | null;
    }
  | { status: 'withdrawn'; number: number; captureId: string; messageId: string; reason: string };

export interface InboxPage {
  entries: InboxEntry[];
  next: number;
  more: boolean;
}

export class InboxReplyError extends Error {}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  // Zod's messages end in a full stop; ours wrap them in brackets before one.
  return issue ? `${issue.path.join('.') || 'reply'}: ${issue.message.replace(/\.+$/, '')}` : 'unreadable';
}

/** `YYYY-MM-DD` days become noon local time, like dates picked in the web UI and the Paperless import. */
function dayField(value: unknown): unknown {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return parseDay(value.trim());
  return value;
}

function emailUrl(publicUrl: string | null, link: string): string | null {
  const base = publicUrl?.trim().replace(/\/+$/, '');
  return base ? `${base}${link}` : null;
}

function titleOf(doc: Record<string, unknown>, captureId: string): string {
  for (const key of ['subject', 'biller'] as const) {
    const v = doc[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 200);
  }
  return captureId;
}

/** One ready document as the importer's input, with OurHome's own link to the email. */
export function toIngestInput(
  raw: Record<string, unknown>,
  url: string | null,
): { input: BillIngestInput; problem: null } | { input: null; problem: string } {
  // OurHome builds the link itself (contract); one sent along is ignored.
  const rest: Record<string, unknown> = { ...raw };
  delete rest.sourceUrl;
  const parsed = billIngestSchema.safeParse({
    ...rest,
    dueDate: dayField(rest.dueDate),
    paidDate: dayField(rest.paidDate),
    sourceUrl: url,
  });
  if (!parsed.success) {
    return { input: null, problem: `OurHome can't read what OurHomeInbox sent (${firstIssue(parsed.error)}).` };
  }
  if (parsed.data.kind === 'statement') {
    // Not in the contract; the importer would skip it anyway.
    return { input: null, problem: 'a statement, not a bill or payment' };
  }
  return { input: parsed.data, problem: null };
}

/**
 * Checks one reply of `GET /api/handoff/documents?after=<after>`. A reply that
 * breaks the contract (numbers not rising, an entry without a number) throws,
 * so the stored number is not moved past documents that were never handled.
 * One document whose fields OurHome can't read comes back with a `problem`
 * instead, so it is listed as skipped and the rest still come in.
 */
export function parseDocumentsReply(body: unknown, after: number, publicUrl: string | null): InboxPage {
  const reply = replySchema.safeParse(body);
  if (!reply.success) throw new InboxReplyError(`OurHomeInbox sent a reply OurHome can't read (${firstIssue(reply.error)}).`);

  const entries: InboxEntry[] = [];
  let last = after;
  for (const [i, item] of reply.data.documents.entries()) {
    const base = entryBase.safeParse(item);
    if (!base.success) {
      throw new InboxReplyError(`OurHomeInbox sent a document OurHome can't read (documents.${i}.${firstIssue(base.error)}).`);
    }
    if (base.data.number <= last) {
      throw new InboxReplyError(`OurHomeInbox sent document ${base.data.number} out of order (after ${last}).`);
    }
    last = base.data.number;

    if (base.data.status === 'withdrawn') {
      const w = withdrawnEntry.safeParse(item);
      if (!w.success) {
        throw new InboxReplyError(`OurHomeInbox sent a withdrawn email OurHome can't read (documents.${i}.${firstIssue(w.error)}).`);
      }
      entries.push({ status: 'withdrawn', number: w.data.number, captureId: w.data.captureId, messageId: w.data.messageId, reason: w.data.reason });
      continue;
    }

    const r = readyEntry.safeParse(item);
    if (!r.success) {
      throw new InboxReplyError(`OurHomeInbox sent a document OurHome can't read (documents.${i}.${firstIssue(r.error)}).`);
    }
    const url = emailUrl(publicUrl, r.data.link);
    const mapped = toIngestInput(r.data.document, url);
    entries.push({
      status: 'ready',
      number: r.data.number,
      captureId: r.data.captureId,
      title: titleOf(r.data.document, r.data.captureId),
      input: mapped.input,
      problem: mapped.problem,
      url,
    });
  }

  if (reply.data.next < last) {
    throw new InboxReplyError(`OurHomeInbox said to continue after ${reply.data.next}, before its own document ${last}.`);
  }
  return { entries, next: reply.data.next, more: reply.data.more };
}
