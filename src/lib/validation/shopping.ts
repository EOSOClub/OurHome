import { z } from 'zod';
import { SHOPPING_LIST_KINDS, SHOPPING_PRIORITIES } from '@/lib/enums';

/**
 * A web link: http or https only. `url()` alone also takes javascript: and
 * data: links, which would be stored and later opened from a link on the page
 * or in the app. Shared with purchase requests.
 */
export const httpLink = z
  .string()
  .trim()
  .pipe(
    z
      .url()
      .max(2000)
      // zod runs this even when url() already failed, so a text that isn't a link must not throw here.
      .refine((u) => URL.canParse(u) && /^https?:$/i.test(new URL(u).protocol), 'Use a web link (http or https).'),
  );

export const createShoppingListSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(SHOPPING_LIST_KINDS).default('grocery'),
});

export type CreateShoppingListInput = z.infer<typeof createShoppingListSchema>;

export const renameShoppingListSchema = z.object({
  listId: z.cuid(),
  name: z.string().trim().min(1).max(100),
});

export type RenameShoppingListInput = z.infer<typeof renameShoppingListSchema>;

export const addShoppingItemSchema = z.object({
  listId: z.cuid(),
  name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(999).default(1),
  priority: z.enum(SHOPPING_PRIORITIES).default('medium'),
  notes: z.string().trim().max(1000).optional().nullable(),
  url: httpLink.optional().nullable(),
  imageUrl: httpLink.optional().nullable(),
  estimatedPrice: z.number().nonnegative().max(1_000_000).optional().nullable(),
  recurring: z.boolean().default(false),
  categoryId: z.cuid().optional().nullable(),
});

export type AddShoppingItemInput = z.infer<typeof addShoppingItemSchema>;

export const updateShoppingItemSchema = z.object({
  itemId: z.cuid(),
  name: z.string().trim().min(1).max(200).optional(),
  quantity: z.number().int().min(1).max(999).optional(),
  priority: z.enum(SHOPPING_PRIORITIES).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
  url: httpLink.optional().nullable(),
  imageUrl: httpLink.optional().nullable(),
  estimatedPrice: z.number().nonnegative().max(1_000_000).optional().nullable(),
  recurring: z.boolean().optional(),
  categoryId: z.cuid().optional().nullable(),
});

export type UpdateShoppingItemInput = z.infer<typeof updateShoppingItemSchema>;

export const linkPreviewSchema = z.object({
  url: httpLink,
});

export type LinkPreviewInput = z.infer<typeof linkPreviewSchema>;

export const setItemPurchasedSchema = z.object({
  itemId: z.cuid(),
  purchased: z.boolean(),
});

export type SetItemPurchasedInput = z.infer<typeof setItemPurchasedSchema>;

export const itemIdSchema = z.object({ itemId: z.cuid() });
export type ItemIdInput = z.infer<typeof itemIdSchema>;

export const listIdSchema = z.object({ listId: z.cuid() });
export type ListIdInput = z.infer<typeof listIdSchema>;
