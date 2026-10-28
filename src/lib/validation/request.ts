import { z } from 'zod';
import { MEDIA_TYPES } from '@/lib/enums';
import { httpLink } from '@/lib/validation/shopping';

// A request is either media (name + year, optional TV season) or maintenance
// (what needs doing + who should do it). For media the year is the release
// year for a movie, and for TV the year of the first season (or of the
// requested season when `season` is given). A media request with `issue`
// reports a problem with something the household already has: `details` says
// what's wrong, and on TV `season` (none = the whole show) and `episode`
// (none = the whole season) say where.
// A purchase is what to buy, with an optional link, picture, price of one,
// how many and why (`details`). A permission is what for, with an optional
// from and until (`startsAt`, `endsAt`) and details.

const title = z.string().trim().min(1, 'Name is required.').max(200);
const details = z.string().trim().max(2000).optional().nullable();
const link = httpLink.optional().nullable();

const mediaFields = {
  category: z.literal('media'),
  mediaType: z.enum(MEDIA_TYPES),
  title,
  year: z.number().int().min(1870).max(2100),
  season: z.number().int().min(1).max(100).optional().nullable(),
  // Older app builds don't send these: a request to add it.
  issue: z.boolean().optional(),
  episode: z.number().int().min(1).max(1000).optional().nullable(),
  details,
};

const maintenanceFields = {
  category: z.literal('maintenance'),
  title,
  details,
  // The member asked to do it; the service rejects the requester themself.
  assigneeId: z.string().cuid(),
};

const purchaseFields = {
  category: z.literal('purchase'),
  title,
  details,
  url: link,
  imageUrl: link,
  price: z.number().nonnegative().max(1_000_000).optional().nullable(),
  quantity: z.number().int().min(1).max(999).optional().nullable(),
};

const permissionFields = {
  category: z.literal('permission'),
  title,
  details,
  startsAt: z.coerce.date().optional().nullable(),
  endsAt: z.coerce.date().optional().nullable(),
};

/** Permission: "until" needs a "from" before it, and neither in the past (a day of slack for time zones). */
function checkPermission(r: { category: string; startsAt?: Date | null; endsAt?: Date | null }, ctx: z.RefinementCtx) {
  if (r.category !== 'permission') return;
  if (r.startsAt && r.startsAt.getTime() < Date.now() - 86_400_000) {
    ctx.addIssue({ code: 'custom', message: 'Pick a time from today on.', path: ['startsAt'] });
  }
  if (r.endsAt && !r.startsAt) {
    ctx.addIssue({ code: 'custom', message: 'Say when it starts too.', path: ['startsAt'] });
  } else if (r.endsAt && r.startsAt && r.endsAt <= r.startsAt) {
    ctx.addIssue({ code: 'custom', message: 'Until has to be after from.', path: ['endsAt'] });
  }
}

function checkMedia(
  r: {
    category: string;
    mediaType?: string;
    season?: number | null;
    issue?: boolean;
    episode?: number | null;
    details?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  if (r.category !== 'media') return;
  if (r.mediaType !== 'tv' && r.season != null) {
    ctx.addIssue({
      code: 'custom',
      message: 'Only TV show requests can name a season.',
      path: ['season'],
    });
  }
  if (r.episode != null && !(r.issue && r.mediaType === 'tv' && r.season != null)) {
    ctx.addIssue({
      code: 'custom',
      message: 'An episode goes with a season, on a problem with a TV show.',
      path: ['episode'],
    });
  }
  if (r.issue && !r.details) {
    ctx.addIssue({ code: 'custom', message: 'Say what’s wrong.', path: ['details'] });
  }
}

function checkRequest(r: Parameters<typeof checkMedia>[0] & Parameters<typeof checkPermission>[0], ctx: z.RefinementCtx) {
  checkMedia(r, ctx);
  checkPermission(r, ctx);
}

export const createRequestSchema = z
  .discriminatedUnion('category', [
    z.object(mediaFields),
    z.object(maintenanceFields),
    z.object(purchaseFields),
    z.object(permissionFields),
  ])
  .superRefine(checkRequest);

export type CreateRequestInput = z.infer<typeof createRequestSchema>;

// Updates replace every field (the edit form always sends the full request).
// Whether a media request is a problem report is fixed when it's made; the
// service keeps the stored one.
const id = z.string().cuid();
export const updateRequestSchema = z
  .discriminatedUnion('category', [
    z.object({ id, ...mediaFields }),
    z.object({ id, ...maintenanceFields }),
    z.object({ id, ...purchaseFields }),
    z.object({ id, ...permissionFields }),
  ])
  .superRefine(checkRequest);

export type UpdateRequestInput = z.infer<typeof updateRequestSchema>;

export const requestIdSchema = z.object({ id });
export type RequestIdInput = z.infer<typeof requestIdSchema>;

// The head giving a maintenance request to someone else.
export const reassignRequestSchema = z.object({ id, assigneeId: maintenanceFields.assigneeId });
export type ReassignRequestInput = z.infer<typeof reassignRequestSchema>;

// Marking done / approving. A purchase may name a shopping list to put it on.
export const completeRequestSchema = z.object({ id, listId: z.string().cuid().nullish() });
export type CompleteRequestInput = z.infer<typeof completeRequestSchema>;

// Accepting: a maintenance request's assignee gives a done-by date (the
// deadline; the service requires it unless the head made it optional); older
// app builds accepting a media request send none. A day of slack lets "today"
// through from any timezone.
export const acceptRequestSchema = z.object({
  id,
  dueAt: z.coerce
    .date()
    .refine((d) => d.getTime() >= Date.now() - 86_400_000, 'Pick today or a later date.')
    .optional(),
});

export type AcceptRequestInput = z.infer<typeof acceptRequestSchema>;

// Declining (approve-workflow modules that allow it): an optional reason for
// the requester. Blank is the same as none.
export const declineRequestSchema = z.object({
  id,
  reply: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((s) => (s ? s : null)),
});

export type DeclineRequestInput = z.infer<typeof declineRequestSchema>;
