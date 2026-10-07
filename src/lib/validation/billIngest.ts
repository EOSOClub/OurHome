import { z } from 'zod';

// Contract for a single parsed financial document handed to billIngestService.
// The Paperless import (paperless/mapping.ts) builds these. Field names are camelCase.
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
  // base charge vs. the card/convenience fee. When absent, the ingest service
  // infers the fee from the matched bill's balance (see billIngestService).
  fee: z.number().nonnegative().max(10_000_000).optional().nullable(),
  baseAmount: z.number().nonnegative().max(10_000_000).optional().nullable(),
  currency: z.string().trim().max(8).optional().nullable(),
  dueDate: z.coerce.date().optional().nullable(),
  paidDate: z.coerce.date().optional().nullable(),
  emailDate: z.coerce.date().optional().nullable(),
  invoiceNo: z.string().trim().max(120).optional().nullable(),
  confirmationNo: z.string().trim().max(120).optional().nullable(),
  accountNo: z.string().trim().max(120).optional().nullable(),
  // Stable sender key for matching a payment to its bill when no reference or
  // account number links them (Paperless: "paperless-correspondent:<id>").
  billerKey: z.string().trim().max(200).optional().nullable(),
  // Link back to the original document, e.g. the Paperless details page.
  // http(s) only: it is rendered as a link, and z.url() alone allows javascript:.
  sourceUrl: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((u) => /^https?:$/.test(new URL(u).protocol), 'Must be an http(s) URL.')
    .optional()
    .nullable(),
  confidence: z.number().min(0).max(1).optional().nullable(),
});
export type BillIngestInput = z.infer<typeof billIngestSchema>;
