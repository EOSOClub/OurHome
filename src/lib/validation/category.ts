import { z } from 'zod';
import { CATEGORY_KINDS } from '@/lib/enums';

const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex color like #38bdf8')
  .optional()
  .nullable();

// Short label or emoji; icon rendering is kept simple (no dynamic icon lookup).
const iconSchema = z.string().trim().max(40).optional().nullable();

const nameSchema = z.string().trim().min(1).max(60);

export const createCategorySchema = z.object({
  name: nameSchema,
  kind: z.enum(CATEGORY_KINDS).default('general'),
  color: colorSchema,
  icon: iconSchema,
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z.object({
  id: z.string().cuid(),
  name: nameSchema.optional(),
  kind: z.enum(CATEGORY_KINDS).optional(),
  color: colorSchema,
  icon: iconSchema,
});
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const categoryIdSchema = z.object({ id: z.string().cuid() });
export type CategoryIdInput = z.infer<typeof categoryIdSchema>;

export const listCategoriesQuerySchema = z.object({
  kind: z.enum(CATEGORY_KINDS).optional(),
});
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
