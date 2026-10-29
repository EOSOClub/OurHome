import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';
import { NFC_REPRESENTS, NFC_SCAN_ACTIONS } from '@/lib/enums';

// A physical tag id. Tags written by the Home Assistant companion app carry a
// UUID (read by HA and by the Android app alike); for tags without one, the
// Android app uses "uid:<hardware id hex>".
// Kept to a stable, slug-like shape so it round-trips cleanly through HA.
export const tagIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[\w.:-]+$/, 'Use letters, numbers, dot, colon, dash or underscore.');

// Per-tag app behavior; omitted fields keep whatever the tag already has.
const scanSettings = {
  scanAction: z.enum(NFC_SCAN_ACTIONS).optional(),
  shoppingListId: recordId.optional().nullable(),
};

// Register (or re-bind) a tag: a location tag to a room, any other kind to a
// single inventory item.
export const registerNfcTagSchema = z
  .object({
    tagId: tagIdSchema,
    label: z.string().trim().min(1).max(120),
    itemId: recordId.optional().nullable(),
    roomId: recordId.optional().nullable(),
    represents: z.enum(NFC_REPRESENTS).default('consumable'),
    ...scanSettings,
  })
  .refine((v) => (v.represents === 'location' ? Boolean(v.roomId) : Boolean(v.itemId)), {
    message: 'A location tag needs a room; any other tag needs an item.',
  });

export type RegisterNfcTagInput = z.infer<typeof registerNfcTagSchema>;

export const nfcTagIdSchema = z.object({ id: recordId });

// --- Scanning from the Android app (session auth, not the HA webhook) -------

export const nfcLookupQuerySchema = z.object({ tagId: tagIdSchema });

// Apply a scan: a signed decimal delta, like the HA webhook's `amount`.
export const nfcAppScanSchema = z.object({
  tagId: tagIdSchema,
  amount: z
    .number()
    .refine((n) => n !== 0, 'Scan amount must be non-zero.'),
  note: z.string().trim().max(500).optional().nullable(),
});

const quantity = z.number().min(0).max(1_000_000);

// Set up a tag in one step: bind it to an existing item, create the item, or
// make it a location tag for a room.
export const nfcSetupSchema = z
  .object({
    tagId: tagIdSchema,
    // Defaults to the item's (or room's) name.
    label: z.string().trim().min(1).max(120).optional().nullable(),
    itemId: recordId.optional().nullable(),
    roomId: recordId.optional().nullable(),
    newItem: z
      .object({
        name: z.string().trim().min(1).max(200),
        unit: z.string().trim().max(40).optional().nullable(),
        quantity: quantity.default(0),
        lowThreshold: quantity.default(0),
        // Where it's kept: a room, or a whole floor.
        roomId: recordId.optional().nullable(),
        floorId: recordId.optional().nullable(),
      })
      .optional()
      .nullable(),
    ...scanSettings,
  })
  .refine((v) => [v.itemId, v.newItem, v.roomId].filter(Boolean).length === 1, {
    message: 'Pick an existing item, describe a new one, or pick a room (just one).',
  });
export type NfcSetupInput = z.infer<typeof nfcSetupSchema>;

// Change how the app treats a scan of an existing tag. Omitted fields keep
// what the tag has; `roomId` only applies to location tags.
export const nfcTagSettingsSchema = z.object({
  tagId: tagIdSchema,
  scanAction: z.enum(NFC_SCAN_ACTIONS).optional(),
  shoppingListId: recordId.optional().nullable(),
  roomId: recordId.optional().nullable(),
});
export type NfcTagSettingsInput = z.infer<typeof nfcTagSettingsSchema>;

// "Add to shopping list" from a quick-scan notification.
export const nfcTagRefSchema = z.object({ tagId: tagIdSchema });

export const nfcScansQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
