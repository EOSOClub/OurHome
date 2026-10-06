import { z } from 'zod';

// Query-string params are strings, so coerce. `unreadOnly` accepts "true"/"1".
export const listNotificationsQuery = z.object({
  unreadOnly: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

// Mark a single notification read by id, or every notification with `all: true`.
export const markReadSchema = z
  .object({
    id: z.string().cuid().optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.id) !== Boolean(v.all), {
    message: 'Provide exactly one of `id` or `all`.',
  });

export type MarkReadInput = z.infer<typeof markReadSchema>;
