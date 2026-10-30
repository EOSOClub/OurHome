import { z } from 'zod';
import { recordId } from '@/lib/validation/ids';
import { MAX_ROTATION } from '@/lib/taskRotation';
import {
  RECURRENCE_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  WRITABLE_TASK_STATUSES,
} from '@/lib/enums';

// Shared by tasks, bills and calendar events (see validation/bills.ts and
// validation/calendar.ts). 'cron' stays in RECURRENCE_KINDS as a reserved
// value, but the recurrence engine can't advance it yet, so accepting it would
// create rules that silently never recur - reject it at the boundary instead.
export const recurrenceInputSchema = z
  .object({
    kind: z.enum(RECURRENCE_KINDS),
    interval: z.number().int().positive().max(365).default(1),
    // 0 = Sunday through 6 = Saturday
    byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
    byMonthday: z.array(z.number().int().min(1).max(31)).optional(),
    cron: z.string().trim().min(1).max(120).optional(),
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    anchorDate: z.coerce.date().optional(),
    // optional end date: occurrences stop after this instant
    until: z.coerce.date().optional().nullable(),
    // Tasks only: run in cycles that roll over at local midnight. Weekly
    // needs cycleWeekdays and monthly needs cycleMonthdays; daily/interval
    // cycles follow the rule itself. Month days past a month's end start on
    // its last day, so only 1-31 are accepted.
    rollover: z.boolean().optional(),
    cycleWeekdays: z.array(z.number().int().min(0).max(6)).max(7).optional().nullable(),
    cycleMonthdays: z.array(z.number().int().min(1).max(31)).max(31).optional().nullable(),
  })
  .refine((r) => r.kind !== 'cron', {
    message: 'cron recurrence is not yet supported',
    path: ['kind'],
  })
  .refine((r) => !r.rollover || r.kind !== 'weekly' || (r.cycleWeekdays?.length ?? 0) > 0, {
    message: 'Pick the day(s) each weekly cycle starts.',
    path: ['cycleWeekdays'],
  })
  .refine((r) => !r.rollover || r.kind !== 'monthly' || (r.cycleMonthdays?.length ?? 0) > 0, {
    message: 'Pick the day(s) of the month each cycle starts.',
    path: ['cycleMonthdays'],
  });

export type RecurrenceInput = z.infer<typeof recurrenceInputSchema>;

const estimatedMinutesSchema = z.number().int().positive().max(100000);

// Points as entered (2 decimals kept; stored as hundredths).
const pointsSchema = z.number().min(0).max(100000);

// Auto-uncheck cadence for a checklist item, as a day count (null clears it).
const resetIntervalDaysSchema = z.number().int().min(1).max(365);

// A checklist item as the task editor saves it. Time/points values come from
// the editor's live calculation (src/lib/taskPoints.ts); the server fills in
// omitted ones. `id` keeps an existing item when replacing the
// whole checklist on update.
const subtaskInputSchema = z.object({
  id: recordId.optional(),
  title: z.string().trim().min(1).max(200),
  done: z.boolean().default(false),
  resetIntervalDays: resetIntervalDaysSchema.optional().nullable(),
  minutes: z.number().int().min(0).max(100000).optional(),
  points: pointsSchema.optional(),
  minutesCustom: z.boolean().optional(),
  pointsFollowTime: z.boolean().optional(),
});

export type SubtaskInput = z.infer<typeof subtaskInputSchema>;

// The whole checklist as the editor saves it. An id may appear once: it names
// the row that keeps its place and values.
const checklistSchema = z
  .array(subtaskInputSchema)
  .max(50)
  .refine((items) => {
    const ids = items.map((i) => i.id).filter(Boolean);
    return new Set(ids).size === ids.length;
  }, 'A checklist step appears twice.');

// A task's places (src/lib/places.ts): rooms and whole floors.
const placeIdsSchema = z.array(recordId).max(50);

// Rotating assignees: member ids in turn order (src/lib/taskRotation.ts).
// A list with fewer than two distinct people clears the rotation.
const rotationSchema = z.array(recordId).max(MAX_ROTATION);

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000).optional(),
  type: z.enum(TASK_TYPES).default('one_time'),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  dueDate: z.coerce.date().optional().nullable(),
  // The task-level (base) time to complete and points. Points omitted while
  // they follow time are calculated from the household rate.
  estimatedMinutes: estimatedMinutesSchema.optional().nullable(),
  points: pointsSchema.optional().nullable(),
  pointsFollowTime: z.boolean().optional(),
  categoryId: recordId.optional().nullable(),
  // Where: any rooms and whole floors (neither = the whole house). App
  // builds from before several places send one roomId or floorId instead (a
  // room wins if both are sent); the lists win when present.
  roomIds: placeIdsSchema.optional(),
  floorIds: placeIdsSchema.optional(),
  roomId: recordId.optional().nullable(),
  floorId: recordId.optional().nullable(),
  assigneeId: recordId.optional().nullable(),
  rotationUserIds: rotationSchema.optional().nullable(),
  recurrence: recurrenceInputSchema.optional(),
  subtasks: checklistSchema.optional(),
  // "Ask for a photo": a supervised child or teen sends it for a check with a
  // photo. Never changed by a supervised child or teen (403).
  photoProof: z.boolean().optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

/**
 * The full new order of the tasks in one place (a room, a whole floor, or
 * the whole house); positions become the array index.
 */
export const reorderTasksSchema = z.object({
  taskIds: z.array(recordId).min(1).max(500),
});
export type ReorderTasksInput = z.infer<typeof reorderTasksSchema>;

export const updateTaskSchema = z.object({
  taskId: recordId,
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  // Never awaiting_review: only sending a task for a check sets that.
  status: z.enum(WRITABLE_TASK_STATUSES).optional(),
  dueDate: z.coerce.date().optional().nullable(),
  // Base time/points (see createTaskSchema). Without `subtasks`, a changed
  // base is redistributed over the steps on the server (older clients).
  estimatedMinutes: estimatedMinutesSchema.optional().nullable(),
  points: pointsSchema.optional().nullable(),
  pointsFollowTime: z.boolean().optional(),
  categoryId: recordId.optional().nullable(),
  // When either list is present, all the task's places are replaced (a
  // missing list counts as []; both lists empty = the whole house).
  roomIds: placeIdsSchema.optional(),
  floorIds: placeIdsSchema.optional(),
  // Older app builds: when either is present, the task's FIRST place is
  // replaced (a room, else a whole floor, else none), and any further places
  // are kept. Ignored when a list is sent. Both absent = unchanged.
  roomId: recordId.optional().nullable(),
  floorId: recordId.optional().nullable(),
  assigneeId: recordId.optional().nullable(),
  // When present, replaces the rotation; `null` or [] clears it.
  rotationUserIds: rotationSchema.optional().nullable(),
  // When present, replaces the task's recurrence rule. `null` clears it.
  recurrence: recurrenceInputSchema.optional().nullable(),
  // When present, the whole checklist as the editor left it: items with an
  // `id` are updated, new ones created, missing ones deleted, order = array.
  subtasks: checklistSchema.optional(),
  // "Ask for a photo" (see createTaskSchema).
  photoProof: z.boolean().optional(),
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const undoCompletionSchema = z.object({ completionId: recordId });

/**
 * Longest `photo` accepted: base64 of the largest photo the server keeps
 * (PHOTO_MAX_BYTES in src/server/security/jpeg.ts, 1.5 MiB, is 2,097,152
 * characters), plus room for a "data:image/jpeg;base64," prefix.
 */
export const PHOTO_BASE64_MAX = 2_097_152 + 32;

/**
 * Most bytes POST /api/tasks/complete reads (readJsonCapped): a full-size
 * photo as base64 plus the other fields. Every other route keeps the
 * ordinary body limit.
 */
export const COMPLETE_BODY_MAX_BYTES = Math.floor(2.3 * 1024 * 1024);

export const completeTaskSchema = z
  .object({
    taskId: recordId,
    note: z.string().trim().max(500).optional(),
    // Task Photo Proof. `checks`: this app can send a task for a check (new
    // builds send 1 on every complete call). `forCheck`: send it for a check
    // now. `photo`: one JPEG as base64, only with forCheck.
    checks: z.number().int().min(0).max(100).optional(),
    forCheck: z.boolean().optional(),
    photo: z.string().min(1).max(PHOTO_BASE64_MAX).optional(),
  })
  .refine((i) => i.photo === undefined || i.forCheck === true, {
    message: 'A photo is only sent with a check.',
    path: ['photo'],
  });

export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;

// --- Checks (Task Photo Proof) --------------------------------------------

/** An adult's decision on a check: approve it, or send it back saying what needs fixing. */
export const decideSubmissionSchema = z
  .object({
    submissionId: recordId,
    decision: z.enum(['approve', 'send_back']),
    reviewNote: z.string().trim().min(1).max(300).optional(),
    // Steps to do again (a "task" check only); the rest stay done.
    redoStepIds: z.array(recordId).max(50).optional(),
  })
  .refine((d) => d.decision !== 'send_back' || !!d.reviewNote, {
    message: 'Say what needs fixing.',
    path: ['reviewNote'],
  });

export type DecideSubmissionInput = z.infer<typeof decideSubmissionSchema>;

/** The child taking back their own waiting check. */
export const withdrawSubmissionSchema = z.object({ submissionId: recordId });

/** GET /api/tasks/submissions/photo?id= */
export const submissionPhotoQuerySchema = z.object({ id: recordId });

export const deleteTaskSchema = z.object({ taskId: recordId });

export const listTasksQuerySchema = z.object({
  // A filter, so every status (awaiting_review included) is fine here.
  status: z.enum(TASK_STATUSES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  assigneeId: recordId.optional(),
});

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const taskCompletionsQuerySchema = z.object({
  taskId: recordId,
});

// --- Subtasks -------------------------------------------------------------

export const createSubtaskSchema = z.object({
  taskId: recordId,
  title: z.string().trim().min(1).max(200),
  resetIntervalDays: resetIntervalDaysSchema.optional().nullable(),
});

export type CreateSubtaskInput = z.infer<typeof createSubtaskSchema>;

export const updateSubtaskSchema = z.object({
  subtaskId: recordId,
  title: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  resetIntervalDays: resetIntervalDaysSchema.optional().nullable(),
});

export type UpdateSubtaskInput = z.infer<typeof updateSubtaskSchema>;

// Full explicit order for a task's checklist; positions are set to the array
// index in one transaction.
export const reorderSubtasksSchema = z.object({
  taskId: recordId,
  subtaskIds: z.array(recordId).min(1).max(50),
});

export type ReorderSubtasksInput = z.infer<typeof reorderSubtasksSchema>;

export const deleteSubtaskSchema = z.object({ subtaskId: recordId });
