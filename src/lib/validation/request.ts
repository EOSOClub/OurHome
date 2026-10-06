import { z } from 'zod';
import { MEDIA_TYPES } from '@/lib/enums';

// A request is either media (name + year, optional TV season) or maintenance
// (what needs doing + who should do it). For media the year is the release
// year for a movie, and for TV the year of the first season (or of the
// requested season when `season` is given).

const title = z.string().trim().min(1, 'Name is required.').max(200);

const mediaFields = {
  category: z.literal('media'),
  mediaType: z.enum(MEDIA_TYPES),
  title,
  year: z.number().int().min(1870).max(2100),
  season: z.number().int().min(1).max(100).optional().nullable(),
};

const maintenanceFields = {
  category: z.literal('maintenance'),
  title,
  details: z.string().trim().max(2000).optional().nullable(),
  // The member asked to do it; the service rejects the requester themself.
  assigneeId: z.string().cuid(),
};

function seasonOnlyForTv(
  r: { category: string; mediaType?: string; season?: number | null },
  ctx: z.RefinementCtx,
) {
  if (r.category === 'media' && r.mediaType !== 'tv' && r.season != null) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only TV show requests can name a season.',
      path: ['season'],
    });
  }
}

export const createRequestSchema = z
  .discriminatedUnion('category', [z.object(mediaFields), z.object(maintenanceFields)])
  .superRefine(seasonOnlyForTv);

export type CreateRequestInput = z.infer<typeof createRequestSchema>;

// Updates replace every field (the edit form always sends the full request).
const id = z.string().cuid();
export const updateRequestSchema = z
  .discriminatedUnion('category', [
    z.object({ id, ...mediaFields }),
    z.object({ id, ...maintenanceFields }),
  ])
  .superRefine(seasonOnlyForTv);

export type UpdateRequestInput = z.infer<typeof updateRequestSchema>;

export const requestIdSchema = z.object({ id });
export type RequestIdInput = z.infer<typeof requestIdSchema>;

// Accepting: a maintenance request's assignee must give a done-by date (the
// deadline; the service enforces it's present); the head accepting a media
// request sends none. A day of slack lets "today" through from any timezone.
export const acceptRequestSchema = z.object({
  id,
  dueAt: z.coerce
    .date()
    .refine((d) => d.getTime() >= Date.now() - 86_400_000, 'Pick today or a later date.')
    .optional(),
});

export type AcceptRequestInput = z.infer<typeof acceptRequestSchema>;
