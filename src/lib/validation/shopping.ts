import { z } from 'zod';
import { SHOPPING_LIST_KINDS, SHOPPING_PRIORITIES } from '@/lib/enums';

export const createShoppingListSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(SHOPPING_LIST_KINDS).default('grocery'),
});

export type CreateShoppingListInput = z.infer<typeof createShoppingListSchema>;

export const renameShoppingListSchema = z.object({
  listId: z.string().cuid(),
  name: z.string().trim().min(1).max(100),
});

export type RenameShoppingListInput = z.infer<typeof renameShoppingListSchema>;

export const addShoppingItemSchema = z.object({
  listId: z.string().cuid(),
  name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(999).default(1),
  priority: z.enum(SHOPPING_PRIORITIES).default('medium'),
  notes: z.string().trim().max(1000).optional().nullable(),
  url: z.string().trim().url().max(2000).optional().nullable(),
  imageUrl: z.string().trim().url().max(2000).optional().nullable(),
  estimatedPrice: z.number().nonnegative().max(1_000_000).optional().nullable(),
  recurring: z.boolean().default(false),
  categoryId: z.string().cuid().optional().nullable(),
});

export type AddShoppingItemInput = z.infer<typeof addShoppingItemSchema>;

export const updateShoppingItemSchema = z.object({
  itemId: z.string().cuid(),
  name: z.string().trim().min(1).max(200).optional(),
  quantity: z.number().int().min(1).max(999).optional(),
  priority: z.enum(SHOPPING_PRIORITIES).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
  url: z.string().trim().url().max(2000).optional().nullable(),
  imageUrl: z.string().trim().url().max(2000).optional().nullable(),
  estimatedPrice: z.number().nonnegative().max(1_000_000).optional().nullable(),
  recurring: z.boolean().optional(),
  categoryId: z.string().cuid().optional().nullable(),
});

export type UpdateShoppingItemInput = z.infer<typeof updateShoppingItemSchema>;

export const linkPreviewSchema = z.object({
  url: z.string().trim().url().max(2000),
});

export type LinkPreviewInput = z.infer<typeof linkPreviewSchema>;

export const setItemPurchasedSchema = z.object({
  itemId: z.string().cuid(),
  purchased: z.boolean(),
});

export type SetItemPurchasedInput = z.infer<typeof setItemPurchasedSchema>;

export const itemIdSchema = z.object({ itemId: z.string().cuid() });
export type ItemIdInput = z.infer<typeof itemIdSchema>;

export const listIdSchema = z.object({ listId: z.string().cuid() });
export type ListIdInput = z.infer<typeof listIdSchema>;
