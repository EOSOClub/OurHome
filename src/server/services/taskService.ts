import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import type { SubtaskDTO, TaskCompletionDTO, TaskDTO } from '@/lib/types';
import type {
  CompleteTaskInput,
  CreateSubtaskInput,
  CreateTaskInput,
  ListTasksQuery,
  RecurrenceInput,
  ReorderSubtasksInput,
  UpdateSubtaskInput,
  UpdateTaskInput,
} from '@/lib/validation/task';
import { logActivity } from '@/server/services/activityService';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '@/server/services/errors';
import {
  computeNextRunAt,
  formatIntList,
  parseIntList,
  type NormalizedRule,
} from '@/server/services/recurrenceService';

const taskInclude = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  assignee: { select: { id: true, name: true } },
  recurrence: true,
  subtasks: { orderBy: { position: 'asc' } },
} satisfies Prisma.TaskInclude;

export type TaskWithRelations = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

type CompletionWithUser = Prisma.TaskCompletionGetPayload<{
  include: { user: { select: { id: true; name: true } } };
}>;

function subtaskToDTO(s: TaskWithRelations['subtasks'][number]): SubtaskDTO {
  return {
    id: s.id,
    title: s.title,
    done: s.done,
    doneAt: s.doneAt?.toISOString() ?? null,
    resetIntervalDays: s.resetIntervalDays,
    position: s.position,
  };
}

/** Map a Prisma task (with relations) to the serializable client DTO. */
export function taskToDTO(task: TaskWithRelations): TaskDTO {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    type: task.type,
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    estimatedMinutes: task.estimatedMinutes,
    category: task.category
      ? { id: task.category.id, name: task.category.name, color: task.category.color }
      : null,
    assignee: task.assignee
      ? { id: task.assignee.id, name: task.assignee.name }
      : null,
    recurrence: task.recurrence
      ? {
          kind: task.recurrence.kind,
          interval: task.recurrence.interval,
          byWeekday: task.recurrence.byWeekday,
          byMonthday: task.recurrence.byMonthday,
          timezone: task.recurrence.timezone,
          until: task.recurrence.until?.toISOString() ?? null,
          nextRunAt: task.recurrence.nextRunAt?.toISOString() ?? null,
        }
      : null,
    subtasks: task.subtasks.map(subtaskToDTO),
  };
}

export function completionToDTO(c: CompletionWithUser): TaskCompletionDTO {
  return {
    id: c.id,
    note: c.note,
    completedAt: c.completedAt.toISOString(),
    user: c.user ? { id: c.user.id, name: c.user.name } : null,
  };
}

function normalizeRule(rule: {
  kind: string;
  interval: number;
  byWeekday: string | null;
  byMonthday: string | null;
  cron: string | null;
  anchorDate: Date;
  until: Date | null;
}): NormalizedRule {
  return {
    kind: rule.kind as NormalizedRule['kind'],
    interval: rule.interval,
    byWeekday: parseIntList(rule.byWeekday),
    byMonthday: parseIntList(rule.byMonthday),
    cron: rule.cron,
    anchorDate: rule.anchorDate,
    until: rule.until,
  };
}

/** Build the persisted RecurrenceRule columns from validated input. */
function recurrenceData(recurrence: RecurrenceInput, dueDate: Date | null | undefined) {
  const anchor = dueDate ?? recurrence.anchorDate ?? new Date();
  return {
    kind: recurrence.kind,
    interval: recurrence.interval,
    byWeekday: formatIntList(recurrence.byWeekday),
    byMonthday: formatIntList(recurrence.byMonthday),
    cron: recurrence.cron ?? null,
    timezone: recurrence.timezone,
    anchorDate: anchor,
    until: recurrence.until ?? null,
    nextRunAt: dueDate ?? anchor,
  };
}

export async function createTask(
  householdId: string,
  userId: string,
  input: CreateTaskInput,
): Promise<TaskWithRelations> {
  return prisma.$transaction(async (tx) => {
    let recurrenceId: string | undefined;

    if (input.recurrence) {
      const rule = await tx.recurrenceRule.create({
        data: recurrenceData(input.recurrence, input.dueDate),
      });
      recurrenceId = rule.id;
    }

    const task = await tx.task.create({
      data: {
        householdId,
        title: input.title,
        notes: input.notes ?? null,
        type: input.recurrence ? 'recurring' : input.type,
        priority: input.priority,
        dueDate: input.dueDate ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
        categoryId: input.categoryId ?? null,
        assigneeId: input.assigneeId ?? null,
        createdById: userId,
        recurrenceId,
        subtasks: input.subtasks?.length
          ? {
              create: input.subtasks.map((s, i) => ({
                title: s.title,
                done: s.done,
                doneAt: s.done ? new Date() : null,
                resetIntervalDays: s.resetIntervalDays ?? null,
                position: i,
              })),
            }
          : undefined,
      },
      include: taskInclude,
    });

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'created',
        subjectType: 'task',
        subjectId: task.id,
        message: `created ${task.recurrence ? 'recurring ' : ''}task “${task.title}”`,
      },
      tx,
    );

    return task;
  });
}

/**
 * Auto-uncheck checklist items whose `resetIntervalDays` cadence has elapsed
 * since they were checked (e.g. "dishes" flips back daily inside a task that
 * repeats every 3 days). Runs opportunistically before task reads and from the
 * reminder cron, mirroring how reminders regenerate. The elapsed check is
 * `doneAt + N×24h <= now`, computed in JS because the cutoff varies per row.
 */
export async function resetDueSubtasks(householdId: string): Promise<number> {
  const candidates = await prisma.subtask.findMany({
    where: {
      done: true,
      resetIntervalDays: { not: null },
      task: { householdId },
    },
    select: { id: true, doneAt: true, resetIntervalDays: true },
  });
  const now = Date.now();
  const dueIds = candidates
    .filter(
      (s) =>
        // Items checked before doneAt existed reset immediately — better than
        // sticking checked forever.
        s.doneAt === null ||
        s.doneAt.getTime() + s.resetIntervalDays! * 86_400_000 <= now,
    )
    .map((s) => s.id);
  if (dueIds.length === 0) return 0;
  const { count } = await prisma.subtask.updateMany({
    where: { id: { in: dueIds } },
    data: { done: false, doneAt: null },
  });
  return count;
}

export async function listTasks(
  householdId: string,
  query: ListTasksQuery,
): Promise<TaskWithRelations[]> {
  await resetDueSubtasks(householdId);
  const rows = await prisma.task.findMany({
    where: {
      householdId,
      status: query.status ?? { not: 'archived' },
      type: query.type,
      assigneeId: query.assigneeId,
    },
    include: taskInclude,
  });
  // Order in memory: MongoDB sorts null dates FIRST, but we want tasks with no
  // due date last. Priority: dueDate (asc, nulls last) -> newest first.
  rows.sort((a, b) => {
    const ad = a.dueDate?.getTime() ?? null;
    const bd = b.dueDate?.getTime() ?? null;
    if (ad !== bd) {
      if (ad === null) return 1;
      if (bd === null) return -1;
      return ad - bd;
    }
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  return rows;
}

export async function updateTask(
  householdId: string,
  userId: string,
  input: UpdateTaskInput,
): Promise<TaskWithRelations> {
  const { taskId, recurrence, ...rest } = input;

  return prisma.$transaction(async (tx) => {
    // Scope the update to the household so members can't touch other households.
    const existing = await tx.task.findFirst({
      where: { id: taskId, householdId },
      select: { id: true, recurrenceId: true, dueDate: true },
    });
    if (!existing) throw new TaskNotFoundError(taskId);

    let recurrenceId: string | null | undefined; // undefined = unchanged
    let typeOverride: string | undefined;

    if (recurrence === null) {
      // Clear recurrence: the task becomes a one-time task.
      recurrenceId = null;
      if (rest.type === undefined) typeOverride = 'one_time';
    } else if (recurrence) {
      const dueDate = rest.dueDate ?? existing.dueDate;
      const data = recurrenceData(recurrence, dueDate);
      if (existing.recurrenceId) {
        await tx.recurrenceRule.update({
          where: { id: existing.recurrenceId },
          data,
        });
      } else {
        const rule = await tx.recurrenceRule.create({ data });
        recurrenceId = rule.id;
      }
      if (rest.type === undefined) typeOverride = 'recurring';
    }

    const task = await tx.task.update({
      where: { id: taskId },
      data: {
        title: rest.title,
        notes: rest.notes,
        type: rest.type ?? typeOverride,
        priority: rest.priority,
        status: rest.status,
        dueDate: rest.dueDate,
        estimatedMinutes: rest.estimatedMinutes,
        categoryId: rest.categoryId,
        assigneeId: rest.assigneeId,
        recurrenceId,
      },
      include: taskInclude,
    });

    // Drop the orphaned rule after detaching it from the task.
    if (recurrence === null && existing.recurrenceId) {
      await tx.recurrenceRule.delete({ where: { id: existing.recurrenceId } });
    }

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'updated',
        subjectType: 'task',
        subjectId: task.id,
        message: `updated task “${task.title}”`,
      },
      tx,
    );

    return task;
  });
}

/** Who is completing a task; role narrows what guests may complete. */
export interface CompletingActor {
  id: string;
  role: string;
}

/**
 * Complete a task. For recurring tasks this records the completion, then rolls
 * the task forward to its next occurrence (dueDate + rule.nextRunAt advance,
 * status returns to pending). One-time tasks — and recurring tasks whose `until`
 * end date has been reached — are marked completed.
 *
 * Guests hold `tasks:complete` but only for tasks assigned to them (see
 * src/lib/permissions.ts) — that narrower scope is enforced here.
 */
export async function completeTask(
  householdId: string,
  actor: CompletingActor,
  input: CompleteTaskInput,
): Promise<TaskWithRelations> {
  const userId = actor.id;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({
      where: { id: input.taskId, householdId },
      include: { recurrence: true },
    });
    if (!existing) {
      throw new TaskNotFoundError(input.taskId);
    }

    if (actor.role === 'guest' && existing.assigneeId !== actor.id) {
      throw new ForbiddenError(
        'Guests may only complete tasks assigned to them.',
      );
    }

    await tx.taskCompletion.create({
      data: {
        taskId: existing.id,
        userId,
        note: input.note ?? null,
      },
    });

    const now = new Date();
    let task: TaskWithRelations;

    const next = existing.recurrence
      ? computeNextRunAt(normalizeRule(existing.recurrence), now)
      : null;
    // A supported recurring rule that yields no next occurrence has reached its
    // `until` end date and should finalize. (cron yields null but isn't ended.)
    const recurrenceEnded =
      !!existing.recurrence && existing.recurrence.kind !== 'cron' && next === null;

    if (existing.recurrence && !recurrenceEnded) {
      await tx.recurrenceRule.update({
        where: { id: existing.recurrence.id },
        data: { nextRunAt: next },
      });
      // The task starts its next cycle fresh: uncheck the whole checklist.
      await tx.subtask.updateMany({
        where: { taskId: existing.id, done: true },
        data: { done: false, doneAt: null },
      });
      task = await tx.task.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          completedAt: null,
          dueDate: next ?? existing.dueDate,
        },
        include: taskInclude,
      });
    } else {
      task = await tx.task.update({
        where: { id: existing.id },
        data: { status: 'completed', completedAt: now },
        include: taskInclude,
      });
    }

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'completed',
        subjectType: 'task',
        subjectId: task.id,
        message: `completed task “${task.title}”`,
        metadata: input.note ? { note: input.note } : undefined,
      },
      tx,
    );

    return task;
  });
}

/** Recent completion history for a task, newest first. */
export async function listTaskCompletions(
  householdId: string,
  taskId: string,
  limit = 20,
): Promise<CompletionWithUser[]> {
  await assertTaskInHousehold(taskId, householdId);
  return prisma.taskCompletion.findMany({
    where: { taskId },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { completedAt: 'desc' },
    take: limit,
  });
}

/**
 * Permanently delete a task. Completions and subtasks cascade via their DB
 * relation, but the recurrence rule is the FK parent (Task.recurrenceId ->
 * SetNull on delete) so it is removed explicitly to avoid orphaning it.
 */
export async function deleteTask(
  householdId: string,
  userId: string,
  taskId: string,
): Promise<void> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({
      where: { id: taskId, householdId },
      select: { id: true, title: true, recurrenceId: true },
    });
    if (!existing) {
      throw new TaskNotFoundError(taskId);
    }

    await tx.task.delete({ where: { id: existing.id } });
    if (existing.recurrenceId) {
      await tx.recurrenceRule.delete({ where: { id: existing.recurrenceId } });
    }

    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'deleted',
        subjectType: 'task',
        subjectId: existing.id,
        message: `deleted task “${existing.title}”`,
      },
      tx,
    );
  });
}

// --- Subtasks -------------------------------------------------------------

export async function addSubtask(
  householdId: string,
  input: CreateSubtaskInput,
): Promise<TaskWithRelations> {
  await assertTaskInHousehold(input.taskId, householdId);
  const count = await prisma.subtask.count({ where: { taskId: input.taskId } });
  await prisma.subtask.create({
    data: {
      taskId: input.taskId,
      title: input.title,
      resetIntervalDays: input.resetIntervalDays ?? null,
      position: count,
    },
  });
  return getTaskOrThrow(householdId, input.taskId);
}

export async function updateSubtask(
  householdId: string,
  input: UpdateSubtaskInput,
  actor?: CompletingActor,
): Promise<TaskWithRelations> {
  const taskId = await assertSubtaskInHousehold(input.subtaskId, householdId);
  // Guests may toggle items only on tasks assigned to them — the same scope
  // as completeTask (their route permission is tasks:complete).
  if (actor?.role === 'guest') {
    const task = await prisma.task.findFirst({
      where: { id: taskId, householdId },
      select: { assigneeId: true },
    });
    if (task?.assigneeId !== actor.id) {
      throw new ForbiddenError(
        'Guests may only check items on tasks assigned to them.',
      );
    }
  }
  await prisma.subtask.update({
    where: { id: input.subtaskId },
    data: {
      title: input.title,
      done: input.done,
      // Track when the item was checked so resetIntervalDays knows when to
      // flip it back; clearing on uncheck keeps stale timestamps out.
      ...(input.done !== undefined
        ? { doneAt: input.done ? new Date() : null }
        : {}),
      position: input.position,
      resetIntervalDays: input.resetIntervalDays,
    },
  });
  return getTaskOrThrow(householdId, taskId);
}

/**
 * Persist a full checklist order: each subtask's position becomes its index in
 * `subtaskIds`. The id set must exactly match the task's current checklist so a
 * concurrent add/delete can't be silently dropped or reordered onto the wrong
 * rows.
 */
export async function reorderSubtasks(
  householdId: string,
  input: ReorderSubtasksInput,
): Promise<TaskWithRelations> {
  await assertTaskInHousehold(input.taskId, householdId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.subtask.findMany({
      where: { taskId: input.taskId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((s) => s.id));
    const sameSet =
      existing.length === input.subtaskIds.length &&
      input.subtaskIds.every((id) => existingIds.has(id));
    if (!sameSet) {
      throw new SubtaskOrderConflictError(input.taskId);
    }
    for (const [index, id] of input.subtaskIds.entries()) {
      await tx.subtask.update({ where: { id }, data: { position: index } });
    }
    const task = await tx.task.findFirst({
      where: { id: input.taskId, householdId },
      include: taskInclude,
    });
    if (!task) throw new TaskNotFoundError(input.taskId);
    return task;
  });
}

export async function deleteSubtask(
  householdId: string,
  subtaskId: string,
): Promise<TaskWithRelations> {
  const taskId = await assertSubtaskInHousehold(subtaskId, householdId);
  await prisma.subtask.delete({ where: { id: subtaskId } });
  return getTaskOrThrow(householdId, taskId);
}

async function getTaskOrThrow(
  householdId: string,
  taskId: string,
): Promise<TaskWithRelations> {
  const task = await prisma.task.findFirst({
    where: { id: taskId, householdId },
    include: taskInclude,
  });
  if (!task) throw new TaskNotFoundError(taskId);
  return task;
}

async function assertTaskInHousehold(taskId: string, householdId: string) {
  const found = await prisma.task.findFirst({
    where: { id: taskId, householdId },
    select: { id: true },
  });
  if (!found) throw new TaskNotFoundError(taskId);
}

/** Verify the subtask belongs to a task in this household; returns its taskId. */
async function assertSubtaskInHousehold(
  subtaskId: string,
  householdId: string,
): Promise<string> {
  const found = await prisma.subtask.findFirst({
    where: { id: subtaskId, task: { householdId } },
    select: { taskId: true },
  });
  if (!found) throw new SubtaskNotFoundError(subtaskId);
  return found.taskId;
}

export class TaskNotFoundError extends NotFoundError {
  constructor(taskId: string) {
    super(`Task ${taskId} not found in this household.`);
    this.name = 'TaskNotFoundError';
  }
}

export class SubtaskNotFoundError extends NotFoundError {
  constructor(subtaskId: string) {
    super(`Subtask ${subtaskId} not found in this household.`);
    this.name = 'SubtaskNotFoundError';
  }
}

export class SubtaskOrderConflictError extends ConflictError {
  constructor(taskId: string) {
    super(
      `The checklist for task ${taskId} changed while reordering — refresh and try again.`,
    );
    this.name = 'SubtaskOrderConflictError';
  }
}
