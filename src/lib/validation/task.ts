import { z } from 'zod';
import { MAX_ROTATION } from '@/lib/taskRotation';
import {
  RECURRENCE_KINDS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from '@/lib/enums';

// Shared by tasks, bills and calendar events (see validation/bills.ts and
// validation/calendar.ts). 'cron' stays in RECURRENCE_KINDS as a reserved
// value, but the recurrence engine can't advance it yet, so accepting it would
// create rules that silently never recur — reject it at the boundary instead.
export const recurrenceInputSchema = z
  .object({
    kind: z.enum(RECURRENCE_KINDS),
    interval: z.number().int().positive().max(365).default(1),
    // 0 = Sunday .. 6 = Saturday
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
    // its last day, so only 1–31 are accepted.
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

// Auto-uncheck cadence for a checklist item, in days (null clears it).
const resetIntervalDaysSchema = z.number().int().min(1).max(365);

// A checklist item as the task editor saves it. Time/points values come from
// the editor's live calculation (src/lib/taskPoints.ts); omitted ones are
// filled in by the server. `id` keeps an existing item when replacing the
// whole checklist on update.
const subtaskInputSchema = z.object({
  id: z.string().cuid().optional(),
  title: z.string().trim().min(1).max(200),
  done: z.boolean().default(false),
  resetIntervalDays: resetIntervalDaysSchema.optional().nullable(),
  minutes: z.number().int().min(0).max(100000).optional(),
  points: pointsSchema.optional(),
  minutesCustom: z.boolean().optional(),
  pointsFollowTime: z.boolean().optional(),
});

export type SubtaskInput = z.infer<typeof subtaskInputSchema>;

// Rotating assignees: member ids in turn order (src/lib/taskRotation.ts).
// Fewer than two distinct people clears the rotation.
const rotationSchema = z.array(z.string().cuid()).max(MAX_ROTATION);

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
  categoryId: z.string().cuid().optional().nullable(),
  assigneeId: z.string().cuid().optional().nullable(),
  rotationUserIds: rotationSchema.optional().nullable(),
  recurrence: recurrenceInputSchema.optional(),
  subtasks: z.array(subtaskInputSchema).max(50).optional(),
});

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  taskId: z.string().cuid(),
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  dueDate: z.coerce.date().optional().nullable(),
  // Base time/points (see createTaskSchema). Without `subtasks`, a changed
  // base is redistributed over the steps on the server (older clients).
  estimatedMinutes: estimatedMinutesSchema.optional().nullable(),
  points: pointsSchema.optional().nullable(),
  pointsFollowTime: z.boolean().optional(),
  categoryId: z.string().cuid().optional().nullable(),
  assigneeId: z.string().cuid().optional().nullable(),
  // When present, replaces the rotation; `null` or [] clears it.
  rotationUserIds: rotationSchema.optional().nullable(),
  // When present, replaces the task's recurrence rule. `null` clears it.
  recurrence: recurrenceInputSchema.optional().nullable(),
  // When present, the whole checklist as the editor left it: items with an
  // `id` are updated, new ones created, missing ones deleted, order = array.
  subtasks: z.array(subtaskInputSchema).max(50).optional(),
});

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const undoCompletionSchema = z.object({ completionId: z.string().cuid() });
export type UndoCompletionInput = z.infer<typeof undoCompletionSchema>;

export const completeTaskSchema = z.object({
  taskId: z.string().cuid(),
  note: z.string().trim().max(500).optional(),
});

export type CompleteTaskInput = z.infer<typeof completeTaskSchema>;

export const deleteTaskSchema = z.object({ taskId: z.string().cuid() });
export type DeleteTaskInput = z.infer<typeof deleteTaskSchema>;

export const listTasksQuerySchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  assigneeId: z.string().cuid().optional(),
});

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const taskCompletionsQuerySchema = z.object({
  taskId: z.string().cuid(),
});

export type TaskCompletionsQuery = z.infer<typeof taskCompletionsQuerySchema>;

// --- Subtasks -------------------------------------------------------------

export const createSubtaskSchema = z.object({
  taskId: z.string().cuid(),
  title: z.string().trim().min(1).max(200),
  resetIntervalDays: resetIntervalDaysSchema.optional().nullable(),
});

export type CreateSubtaskInput = z.infer<typeof createSubtaskSchema>;

export const updateSubtaskSchema = z.object({
  subtaskId: z.string().cuid(),
  title: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  resetIntervalDays: resetIntervalDaysSchema.optional().nullable(),
});

export type UpdateSubtaskInput = z.infer<typeof updateSubtaskSchema>;

// Full explicit order for a task's checklist; positions are set to the array
// index in one transaction.
export const reorderSubtasksSchema = z.object({
  taskId: z.string().cuid(),
  subtaskIds: z.array(z.string().cuid()).min(1).max(50),
});

export type ReorderSubtasksInput = z.infer<typeof reorderSubtasksSchema>;

export const deleteSubtaskSchema = z.object({ subtaskId: z.string().cuid() });
export type DeleteSubtaskInput = z.infer<typeof deleteSubtaskSchema>;
