import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';

// Quantities are stored as Float (supports fractional units like "2.5 lbs").
// z.number() already refuses Infinity and NaN.
const quantity = z.number().min(0).max(1_000_000);

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

// delta is a signed decimal: negative removes stock, positive restocks.
export const adjustQuantitySchema = z.object({
  itemId: recordId,
  delta: z
    .number()
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
