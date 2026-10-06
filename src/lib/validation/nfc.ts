import { z } from 'zod';
import { NFC_REPRESENTS, NFC_SCAN_ACTIONS } from '@/lib/enums';

// A physical tag id. Tags written by the Home Assistant companion app carry a
// UUID (read by HA and by the Android app alike); tags without one are
// identified by the Android app as "uid:<hardware id hex>".
// Kept to a stable, slug-like shape so it round-trips cleanly through HA.
export const tagIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\w.:-]+$/, 'Use letters, numbers, dot, colon, dash or underscore.');

// Per-tag app behaviour; omitted fields keep whatever the tag already has.
const scanSettings = {
  scanAction: z.enum(NFC_SCAN_ACTIONS).optional(),
  shoppingListId: z.string().cuid().optional().nullable(),
};

// Register (or re-bind) a tag to a single inventory item.
export const registerNfcTagSchema = z.object({
  tagId: tagIdSchema,
  label: z.string().trim().min(1).max(120),
  itemId: z.string().cuid(),
  represents: z.enum(NFC_REPRESENTS).default('consumable'),
  ...scanSettings,
});

export type RegisterNfcTagInput = z.infer<typeof registerNfcTagSchema>;

export const nfcTagIdSchema = z.object({ id: z.string().cuid() });
export type NfcTagIdInput = z.infer<typeof nfcTagIdSchema>;

// --- Scanning from the Android app (session auth, not the HA webhook) -------

export const nfcLookupQuerySchema = z.object({ tagId: tagIdSchema });

// Apply a scan: a signed decimal delta, like the HA webhook's `amount`.
export const nfcAppScanSchema = z.object({
  tagId: tagIdSchema,
  amount: z
    .number()
    .finite()
    .refine((n) => n !== 0, 'Scan amount must be non-zero.'),
  note: z.string().trim().max(500).optional().nullable(),
});
export type NfcAppScanInput = z.infer<typeof nfcAppScanSchema>;

const quantity = z.number().finite().min(0).max(1_000_000);

// Set up a tag in one step: bind it to an existing item, or create the item.
export const nfcSetupSchema = z
  .object({
    tagId: tagIdSchema,
    // Defaults to the item's name.
    label: z.string().trim().min(1).max(120).optional().nullable(),
    itemId: z.string().cuid().optional().nullable(),
    newItem: z
      .object({
        name: z.string().trim().min(1).max(200),
        unit: z.string().trim().max(40).optional().nullable(),
        quantity: quantity.default(0),
        lowThreshold: quantity.default(0),
      })
      .optional()
      .nullable(),
    ...scanSettings,
  })
  .refine((v) => Boolean(v.itemId) !== Boolean(v.newItem), {
    message: 'Pick an existing item or describe a new one (not both).',
  });
export type NfcSetupInput = z.infer<typeof nfcSetupSchema>;

// Change how the app treats a scan of an existing tag.
export const nfcTagSettingsSchema = z.object({
  tagId: tagIdSchema,
  scanAction: z.enum(NFC_SCAN_ACTIONS),
  shoppingListId: z.string().cuid().optional().nullable(),
});
export type NfcTagSettingsInput = z.infer<typeof nfcTagSettingsSchema>;

// "Add to shopping list" from a quick-scan notification.
export const nfcTagRefSchema = z.object({ tagId: tagIdSchema });

export const nfcScansQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
