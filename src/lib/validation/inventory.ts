import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';

// Quantities are stored as Float (supports fractional units like "2.5 lbs").
// z.number() already refuses Infinity and NaN.
/** The most of anything an item can hold; a stock change can't add more at once. */
export const MAX_QUANTITY = 1_000_000;
const quantity = z.number().min(0).max(MAX_QUANTITY);

/**
 * A stock level kept to six decimals. Quantities are floats, and adding them
 * leaves binary leftovers (0.1 + 0.2 = 0.30000000000000004), which showed up
 * as "now 0.19999999999999998" in Activity and on the item. Six places is far
 * finer than anyone enters (whole units, halves, 0.25 lbs, 1/16 = 0.0625), so
 * only the leftovers go.
 */
export function roundQuantity(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * A stock level after a change: rounded, and within 0..MAX_QUANTITY (the same
 * bounds as a quantity typed in). The server stores this; the page shows the
 * same number while the request is on its way.
 */
export function adjustedQuantity(quantity: number, delta: number): number {
  return Math.min(MAX_QUANTITY, Math.max(0, roundQuantity(quantity + delta)));
}

export const createInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(40).optional().nullable(),
  quantity: quantity.default(0),
  lowThreshold: quantity.default(0),
  reorderIntervalDays: z.number().int().min(1).max(3650).optional().nullable(),
  categoryId: recordId.optional().nullable(),
  // Where it's kept: a room, or a whole floor (a room wins if both are sent).
  roomId: recordId.optional().nullable(),
  floorId: recordId.optional().nullable(),
});

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;

export const updateInventoryItemSchema = z.object({
  itemId: recordId,
  name: z.string().trim().min(1).max(200).optional(),
  unit: z.string().trim().max(40).optional().nullable(),
  quantity: quantity.optional(),
  lowThreshold: quantity.optional(),
  reorderIntervalDays: z.number().int().min(1).max(3650).optional().nullable(),
  categoryId: recordId.optional().nullable(),
  // When either is present the place is replaced: a room, else a whole
  // floor, else (both null) none. Both absent = unchanged.
  roomId: recordId.optional().nullable(),
  floorId: recordId.optional().nullable(),
});

export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;

// delta is a signed decimal: negative removes stock, positive restocks. A
// restock is capped like a quantity, or one change could push an item far
// past MAX_QUANTITY (the service also keeps the result within it). Taking
// away more than there is just empties it, so removing has no cap.
export const adjustQuantitySchema = z.object({
  itemId: recordId,
  delta: z
    .number()
    .max(MAX_QUANTITY)
    .refine((n) => n !== 0, 'Adjustment must be non-zero.'),
  note: z.string().trim().max(500).optional().nullable(),
});

export const itemIdSchema = z.object({ itemId: recordId });

// A 6-digit hex color (e.g. "#fb923c"); the dot on category chips uses it.
const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex code like #fb923c');

export const createInventoryCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: hexColor.optional().nullable(),
});

export type CreateInventoryCategoryInput = z.infer<
  typeof createInventoryCategorySchema
>;

export const categoryIdSchema = z.object({ categoryId: recordId });
