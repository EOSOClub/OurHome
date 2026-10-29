import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';
import { recurrenceInputSchema } from '@/lib/validation/task';

/**
 * Reminder choices, in minutes before the start. A timed event counts back
 * from its start; an all-day one from 9:00 on its day (so 0 = "on the day").
 */
export const TIMED_REMINDERS = [0, 15, 30, 60, 120, 1440] as const;
export const ALL_DAY_REMINDERS = [0, 1440, 2880, 10080] as const;
const REMINDER_MINUTES = new Set<number>([...TIMED_REMINDERS, ...ALL_DAY_REMINDERS]);
const reminderMinutes = z
  .number()
  .int()
  .refine((m) => REMINDER_MINUTES.has(m), { message: 'Pick one of the reminder times.' })
  .optional()
  .nullable();

export const createEventSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional().nullable(),
    location: z.string().trim().max(200).optional().nullable(),
    startAt: z.coerce.date(),
    endAt: z.coerce.date().optional().nullable(),
    allDay: z.boolean().default(false),
    attendeeIds: z.array(recordId).max(50).optional(),
    recurrence: recurrenceInputSchema.optional().nullable(),
    reminderMinutes,
  })
  .refine((e) => !e.endAt || e.endAt >= e.startAt, {
    message: 'The end time must be after the start time.',
    path: ['endAt'],
  });
export type CreateEventInput = z.infer<typeof createEventSchema>;

/**
 * Which dates of a repeating event an edit or delete covers: the one opened
 * ("this"), it and every later one ("following"), or the whole series ("all",
 * the default, so a caller that doesn't know about series still works).
 */
export const EVENT_SCOPES = ['this', 'following', 'all'] as const;
export type EventScope = (typeof EVENT_SCOPES)[number];

const scopeFields = {
  scope: z.enum(EVENT_SCOPES).default('all'),
  // The opened occurrence's start; needed for "this" and "following".
  occurrenceStart: z.coerce.date().optional(),
};
const hasScopeDate = (e: { scope: EventScope; occurrenceStart?: Date }) =>
  e.scope === 'all' || !!e.occurrenceStart;
const scopeDateError = {
  message: 'Pick which date of the event this is for.',
  path: ['occurrenceStart'],
};

export const updateEventSchema = z
  .object({
    id: recordId,
    ...scopeFields,
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    location: z.string().trim().max(200).optional().nullable(),
    startAt: z.coerce.date().optional(),
    endAt: z.coerce.date().optional().nullable(),
    allDay: z.boolean().optional(),
    // When present, replaces the attendee set.
    attendeeIds: z.array(recordId).max(50).optional(),
    // When present, replaces the recurrence rule; `null` clears it.
    recurrence: recurrenceInputSchema.optional().nullable(),
    // `null` turns the reminder off.
    reminderMinutes,
  })
  .refine((e) => !e.startAt || !e.endAt || e.endAt >= e.startAt, {
    message: 'The end time must be after the start time.',
    path: ['endAt'],
  })
  .refine(hasScopeDate, scopeDateError);
export type UpdateEventInput = z.infer<typeof updateEventSchema>;

export const deleteEventSchema = z
  .object({ id: recordId, ...scopeFields })
  .refine(hasScopeDate, scopeDateError);
export type DeleteEventInput = z.infer<typeof deleteEventSchema>;

export const listEventsQuerySchema = z.object({
  start: z.coerce.date(),
  end: z.coerce.date(),
});
