import { z } from 'zod';

// Quantities are stored as Float (supports fractional units like "2.5 lbs").
const quantity = z.number().finite().min(0).max(1_000_000);

export const createInventoryItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  unit: z.string().trim().max(40).optional().nullable(),
  quantity: quantity.default(0),
  lowThreshold: quantity.default(0),
  reorderIntervalDays: z.number().int().min(1).max(3650).optional().nullable(),
  categoryId: z.string().cuid().optional().nullable(),
});

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;

export const updateInventoryItemSchema = z.object({
  itemId: z.string().cuid(),
  name: z.string().trim().min(1).max(200).optional(),
  unit: z.string().trim().max(40).optional().nullable(),
  quantity: quantity.optional(),
  lowThreshold: quantity.optional(),
  reorderIntervalDays: z.number().int().min(1).max(3650).optional().nullable(),
  categoryId: z.string().cuid().optional().nullable(),
});

export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;

// delta is a signed decimal: negative removes stock, positive restocks.
export const adjustQuantitySchema = z.object({
  itemId: z.string().cuid(),
  delta: z
    .number()
    .finite()
    .refine((n) => n !== 0, 'Adjustment must be non-zero.'),
  note: z.string().trim().max(500).optional().nullable(),
});

export type AdjustQuantityInput = z.infer<typeof adjustQuantitySchema>;

export const itemIdSchema = z.object({ itemId: z.string().cuid() });
export type ItemIdInput = z.infer<typeof itemIdSchema>;

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

export const categoryIdSchema = z.object({ categoryId: z.string().cuid() });
export type CategoryIdInput = z.infer<typeof categoryIdSchema>;
