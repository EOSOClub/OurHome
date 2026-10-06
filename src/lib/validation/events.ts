import { z } from 'zod';

// Payload Home Assistant POSTs to /api/webhooks/nfc when a tag is scanned.
// `amount` is a signed decimal delta entered by the user at scan time
// (negative removes stock, positive restocks; fractional allowed).
export const nfcScanWebhookSchema = z.object({
  tagId: z.string().trim().min(1).max(100),
  amount: z
    .number()
    .finite()
    .refine((n) => n !== 0, 'Scan amount must be non-zero.'),
  note: z.string().trim().max(500).optional().nullable(),
  // App username of the person who scanned (sent by Home Assistant, mapped
  // per phone). Resolved to a household member so the activity feed names them;
  // optional so unmapped/legacy scans still validate.
  actor: z.string().trim().min(1).max(100).optional().nullable(),
  // HA tag friendly name. Used only to auto-register a new item the first time
  // an unknown tag is scanned; ignored once the tag is bound to an item.
  name: z.string().trim().min(1).max(200).optional().nullable(),
});

export type NfcScanWebhookInput = z.infer<typeof nfcScanWebhookSchema>;
