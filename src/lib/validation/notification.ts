import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';

// Query-string params are strings, so coerce. `unreadOnly` accepts "true"/"1".
export const listNotificationsQuery = z.object({
  unreadOnly: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

// Mark a single notification read by id, several by `ids` (the reminders one
// phone notification listed, read by tapping it), or every notification with
// `all: true`.
export const markReadSchema = z
  .object({
    id: recordId.optional(),
    ids: z.array(recordId).min(1).max(100).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => [v.id, v.ids, v.all].filter(Boolean).length === 1, {
    message: 'Provide exactly one of `id`, `ids` or `all`.',
  });

export type MarkReadInput = z.infer<typeof markReadSchema>;
