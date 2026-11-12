import { z } from 'zod';

// Contract for a single parsed financial document handed to the bill importer (src/server/billIngest/).
// The Paperless import (paperless/mapping.ts) and the OurHomeInbox import
// (inbox/mapping.ts) build these. Field names are camelCase.
//
// Everything except kind/messageId is optional because the parser omits fields it
// couldn't extract (the document model has no schema to satisfy). `reference` is
// the cross-document link key the parser computes (invoice # > confirmation # >
// generated); the service falls back to deriving one if it is ever missing.
export const billIngestSchema = z.object({
  kind: z.enum(['bill', 'receipt', 'statement']),
  messageId: z.string().trim().min(1).max(998),
  reference: z.string().trim().min(1).max(200).optional().nullable(),
  biller: z.string().trim().max(200).optional().nullable(),
  billerEmail: z.string().trim().max(320).optional().nullable(),
  subject: z.string().trim().max(998).optional().nullable(),
  amount: z.number().nonnegative().max(10_000_000).optional().nullable(),
  totalDue: z.number().nonnegative().max(10_000_000).optional().nullable(),
  // Optional split of a receipt's `amount` when the parser can extract it: the
  // base charge vs. the card/convenience fee. When absent, the importer
  // infers the fee from the matched bill's balance.
  fee: z.number().nonnegative().max(10_000_000).optional().nullable(),
  baseAmount: z.number().nonnegative().max(10_000_000).optional().nullable(),
  // OurHomeInbox (contract v2): true when it judged the payment late. Kept on
  // the payment; the bill page shows "Paid late".
  paidLate: z.boolean().optional().nullable(),
  // A 3-letter code, else none (the importer then uses its default): a "$"
  // read off an email must not fail the document or be stored, since it can't
  // be formatted as money.
  currency: z
    .string()
    .trim()
    .max(8)
    .optional()
    .nullable()
    .transform((s) => (s && /^[A-Za-z]{3}$/.test(s) ? s.toUpperCase() : null)),
  dueDate: z.coerce.date().optional().nullable(),
  paidDate: z.coerce.date().optional().nullable(),
  emailDate: z.coerce.date().optional().nullable(),
  invoiceNo: z.string().trim().max(120).optional().nullable(),
  confirmationNo: z.string().trim().max(120).optional().nullable(),
  accountNo: z.string().trim().max(120).optional().nullable(),
  // Stable sender key for matching a payment to its bill when no reference or
  // account number links them (Paperless: "paperless-correspondent:<id>").
  billerKey: z.string().trim().max(200).optional().nullable(),
  // Link back to the original document, e.g., the Paperless details page.
  // http(s) only: it is rendered as a link, and z.url() alone allows `javascript:` links.
  sourceUrl: z
    .string()
    .trim()
    .pipe(
      z
        .url()
        .max(500)
        // zod runs this even when url() already failed, so a text that isn't a link must not throw here.
        .refine((u) => URL.canParse(u) && /^https?:$/.test(new URL(u).protocol), 'Must be an http(s) URL.'),
    )
    .optional()
    .nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
});
export type BillIngestInput = z.infer<typeof billIngestSchema>;
