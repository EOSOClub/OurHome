import { z } from 'zod';
import { recurrenceInputSchema } from '@/lib/validation/task';

export const createEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    location: z.string().trim().max(200).optional().nullable(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date().optional().nullable(),
    allDay: z.boolean().default(false),
    attendeeIds: z.array(z.string().cuid()).max(50).optional(),
    recurrence: recurrenceInputSchema.optional().nullable(),
  })
  .refine((e) => !e.endAt || e.endAt >= e.startAt, {
    message: 'The end time must be after the start time.',
    path: ['endAt'],
  });
export type CreateEventInput = z.infer<typeof createEventSchema>;

export const updateEventSchema = z
  .object({
    id: z.string().cuid(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    location: z.string().trim().max(200).optional().nullable(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional().nullable(),
    allDay: z.boolean().optional(),
    // When present, replaces the attendee set.
    attendeeIds: z.array(z.string().cuid()).max(50).optional(),
    // When present, replaces the recurrence rule; `null` clears it.
    recurrence: recurrenceInputSchema.optional().nullable(),
  })
  .refine((e) => !e.startAt || !e.endAt || e.endAt >= e.startAt, {
    message: 'The end time must be after the start time.',
    path: ['endAt'],
  });
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const eventIdSchema = z.object({ id: z.string().cuid() });
export type EventIdInput = z.infer<typeof eventIdSchema>;

export const listEventsQuerySchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
});
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
