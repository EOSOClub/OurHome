import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { dateOnOrBefore } from '@/server/db/dateFilters';
import type { SubtaskDTO, TaskCompletionDTO, TaskDTO } from '@/lib/types';
import type {
  CompleteTaskInput,
  CreateSubtaskInput,
  CreateTaskInput,
  ListTasksQuery,
  RecurrenceInput,
  ReorderSubtasksInput,
  SubtaskInput,
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
import {
  addStep,
  formatPoints,
  liveTotals,
  removeStep,
  setTaskFollow,
  setTaskMinutes,
  setTaskPoints,
  toCenti,
  withDefaults,
  type PointsState,
  type StepPoints,
} from '@/lib/taskPoints';
import { cycleStartAt, nextCycleStart, type CycleSpec } from '@/lib/taskCycles';
import {
  assigneeForRotation,
  formatRotation,
  nextInRotation,
  parseRotation,
} from '@/lib/taskRotation';
import {
  UNDO_WINDOW_MS,
  canUndo,
  checkOutcome,
  effectivePoints,
  getPointsSettings,
  planPayout,
  writeAwards,
  type CompletionSnapshot,
  type PointsSettings,
} from '@/server/services/pointsService';

const taskInclude = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  assignee: { select: { id: true, name: true } },
  recurrence: true,
  subtasks: { orderBy: { position: 'asc' } },
} satisfies Prisma.TaskInclude;

export type TaskWithRelations = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
type Tx = Prisma.TransactionClient;
type RuleRow = NonNullable<TaskWithRelations['recurrence']>;

/** Who is acting on a task; role narrows what guests may do. */
export interface CompletingActor {
  id: string;
  role: string;
}

// --- DTOs ---------------------------------------------------------------------

/** What a task DTO needs beyond the row: the rate, member names, queued points. */
export interface TaskContext {
  settings: PointsSettings;
  names: Map<string, string>;
  /** subtaskId → user whose points are queued on it. */
  pending: Map<string, string>;
}

export async function loadTaskContext(householdId: string, taskIds: string[]): Promise<TaskContext> {
  const [settings, members, pending] = await Promise.all([
    getPointsSettings(householdId),
    prisma.user.findMany({ where: { householdId }, select: { id: true, name: true } }),
    taskIds.length
      ? prisma.pendingCredit.findMany({ where: { householdId, taskId: { in: taskIds } } })
      : Promise.resolve([]),
  ]);
  return {
    settings,
    names: new Map(members.map((m) => [m.id, m.name])),
    pending: new Map(pending.map((p) => [p.subtaskId, p.userId])),
  };
}

function member(id: string | null | undefined, names: Map<string, string>) {
  return id ? { id, name: names.get(id) ?? 'Former member' } : null;
}

/** Map a Prisma task (with relations) to the serializable client DTO. */
export function taskToDTO(task: TaskWithRelations, ctx: TaskContext): TaskDTO {
  const state = effectivePoints(task, ctx.settings.minutesPerPoint);
  const live = liveTotals(state);
  // People who left the household drop out of the rotation.
  const rotation = parseRotation(task.rotationUserIds).filter((id) => ctx.names.has(id));
  const next = rotation.length >= 2 ? nextInRotation(rotation, task.assigneeId) : null;
  return {
    id: task.id,
    createdById: task.createdById,
    title: task.title,
    notes: task.notes,
    type: task.type,
    priority: task.priority,
    status: task.status,
    dueDate: task.dueDate?.toISOString() ?? null,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    estimatedMinutes: state.task.baseMinutes === null && live.minutes === 0 ? null : live.minutes,
    points: live.pointsCenti / 100,
    baseMinutes: state.task.baseMinutes,
    basePoints: state.task.basePointsCenti === null ? null : state.task.basePointsCenti / 100,
    pointsFollowTime: state.task.pointsFollowTime,
    minutesPerPoint: ctx.settings.minutesPerPoint,
    cycleStartedAt: task.cycleStartedAt?.toISOString() ?? null,
    cycleEndsAt: task.cycleEndsAt?.toISOString() ?? null,
    category: task.category
      ? { id: task.category.id, name: task.category.name, color: task.category.color }
      : null,
    assignee: task.assignee
      ? { id: task.assignee.id, name: task.assignee.name }
      : null,
    rotation: rotation.length >= 2 ? rotation.map((id) => member(id, ctx.names)!) : [],
    nextAssignee: member(next, ctx.names),
    recurrence: task.recurrence
      ? {
          kind: task.recurrence.kind,
          interval: task.recurrence.interval,
          byWeekday: task.recurrence.byWeekday,
          byMonthday: task.recurrence.byMonthday,
          timezone: task.recurrence.timezone,
          until: task.recurrence.until?.toISOString() ?? null,
          nextRunAt: task.recurrence.nextRunAt?.toISOString() ?? null,
          rollover: task.recurrence.rollover ?? false,
          cycleWeekdays: task.recurrence.cycleWeekdays,
          cycleMonthdays: task.recurrence.cycleMonthdays,
        }
      : null,
    subtasks: task.subtasks.map((s, i): SubtaskDTO => ({
      id: s.id,
      title: s.title,
      done: s.done,
      doneAt: s.doneAt?.toISOString() ?? null,
      doneBy: member(s.doneById, ctx.names),
      queuedFor: member(ctx.pending.get(s.id), ctx.names),
      resetIntervalDays: s.resetIntervalDays,
      position: s.position,
      minutes: state.steps[i].minutes,
      points: state.steps[i].pointsCenti / 100,
      minutesCustom: state.steps[i].minutesCustom,
      pointsFollowTime: state.steps[i].pointsFollowTime,
    })),
  };
}

export async function taskDTO(householdId: string, task: TaskWithRelations): Promise<TaskDTO> {
  return taskToDTO(task, await loadTaskContext(householdId, [task.id]));
}

export async function taskDTOs(householdId: string, tasks: TaskWithRelations[]): Promise<TaskDTO[]> {
  const ctx = await loadTaskContext(householdId, tasks.map((t) => t.id));
  return tasks.map((t) => taskToDTO(t, ctx));
}

// --- Recurrence & cycles --------------------------------------------------------

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

/** The task's cycle boundaries, or null when it doesn't run in cycles. */
export function cycleSpecFor(rule: RuleRow | null | undefined): CycleSpec | null {
  if (!rule?.rollover) return null;
  switch (rule.kind) {
    case 'daily':
      return rule.interval > 1
        ? { kind: 'interval', everyDays: rule.interval, anchor: rule.anchorDate }
        : { kind: 'daily' };
    case 'interval':
      return { kind: 'interval', everyDays: rule.interval, anchor: rule.anchorDate };
    case 'weekly': {
      const days = parseIntList(rule.cycleWeekdays);
      return days ? { kind: 'weekdays', days } : null;
    }
    case 'monthly': {
      const days = parseIntList(rule.cycleMonthdays);
      return days ? { kind: 'monthdays', days } : null;
    }
    default:
      return null;
  }
}

/** The due date inside a cycle window: the rule's first occurrence in it, or
 *  the window's last minute when none falls inside. Null when the rule ended. */
function dueInCycle(rule: RuleRow, start: Date, end: Date): Date | null {
  const next = computeNextRunAt(normalizeRule(rule), new Date(start.getTime() - 1));
  if (!next) return null;
  return next < end ? next : new Date(end.getTime() - 60_000);
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
    rollover: recurrence.rollover ?? false,
    cycleWeekdays: recurrence.kind === 'weekly' ? formatIntList(recurrence.cycleWeekdays) : null,
    cycleMonthdays: recurrence.kind === 'monthly' ? formatIntList(recurrence.cycleMonthdays) : null,
  };
}

/** The cycle window containing `now` for a rule (null fields = no cycles). */
function cycleWindow(rule: RuleRow | null | undefined, tz: string, now: Date) {
  const spec = cycleSpecFor(rule);
  if (!spec) return { cycleStartedAt: null, cycleEndsAt: null };
  return { cycleStartedAt: cycleStartAt(now, spec, tz), cycleEndsAt: nextCycleStart(now, spec, tz) };
}

const UNCHECKED = { done: false, doneAt: null, doneById: null, checkAwardId: null, autoResetAt: null };

// --- Rotating assignees (src/lib/taskRotation.ts) ---------------------------------

/** The rotation's ids that are (still) household members, in order. */
async function liveRotation(db: Tx, householdId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const members = await db.user.findMany({
    where: { householdId, id: { in: [...ids] } },
    select: { id: true },
  });
  const ok = new Set(members.map((m) => m.id));
  return ids.filter((id) => ok.has(id));
}

/** Columns for a save that sets the rotation: the stored list plus the
 *  assignee it leaves (see assigneeForRotation). */
async function rotationColumns(
  db: Tx,
  householdId: string,
  requested: readonly string[] | null,
  assigneeId: string | null | undefined,
  currentAssigneeId: string | null,
) {
  const rotation = parseRotation(formatRotation(await liveRotation(db, householdId, requested ?? [])));
  return {
    rotationUserIds: formatRotation(rotation),
    assigneeId: rotation.length ? assigneeForRotation(rotation, assigneeId, currentAssigneeId) : assigneeId,
  };
}

/** The assignee `steps` turns on, or undefined when the task doesn't rotate. */
async function rotatedAssignee(
  db: Tx,
  householdId: string,
  task: { rotationUserIds: string | null; assigneeId: string | null },
  steps: number,
): Promise<string | undefined> {
  const rotation = await liveRotation(db, householdId, parseRotation(task.rotationUserIds));
  if (rotation.length < 2 || steps < 1) return undefined;
  return nextInRotation(rotation, task.assigneeId, steps) ?? undefined;
}

/** Cap on missed cycles recorded in one catch-up (e.g. after downtime). */
const MAX_MISSED_PER_ROLL = 60;

/**
 * Roll every task whose cycle has ended into its current cycle: a cycle that
 * ended unfinished is recorded as missed (one row per missed cycle) and its
 * queued points are dropped; steps uncheck and the due date moves into the
 * new window. Runs from the reminder sweep and before task reads/changes.
 */
export async function rollTaskCycles(householdId: string, now = new Date(), taskId?: string): Promise<number> {
  const due = await prisma.task.findMany({
    where: { householdId, ...(taskId ? { id: taskId } : {}), cycleEndsAt: dateOnOrBefore(now) },
    select: { id: true },
  });
  if (due.length === 0) return 0;
  const settings = await getPointsSettings(householdId);
  for (const { id } of due) {
    await prisma.$transaction((tx) => rollOne(tx, householdId, id, settings, now));
  }
  return due.length;
}

async function rollOne(tx: Tx, householdId: string, taskId: string, settings: PointsSettings, now: Date) {
  const task = await tx.task.findFirst({
    where: { id: taskId, householdId },
    include: { recurrence: true },
  });
  // Re-check inside the transaction: a concurrent roll may have done it.
  if (!task?.cycleEndsAt || task.cycleEndsAt > now) return;
  const spec = cycleSpecFor(task.recurrence);
  if (!spec || !task.recurrence) {
    await tx.task.update({ where: { id: task.id }, data: { cycleStartedAt: null, cycleEndsAt: null } });
    return;
  }

  let end = task.cycleEndsAt;
  let unfinished = task.status === 'pending' || task.status === 'in_progress';
  let missed = 0;
  let ended = 0; // windows that closed: one rotation turn each, done or not
  while (end <= now) {
    ended += 1;
    if (unfinished && missed < MAX_MISSED_PER_ROLL) {
      await tx.taskCompletion.create({
        data: { taskId: task.id, userId: null, outcome: 'missed', completedAt: end },
      });
      missed += 1;
    }
    unfinished = true; // every later window passed with nobody completing it
    end = nextCycleStart(end, spec, settings.timezone);
  }
  const start = cycleStartAt(now, spec, settings.timezone);
  const dueDate = dueInCycle(task.recurrence, start, end);
  if (dueDate === null) {
    // The rule's end date passed: stop cycling and leave the task as it is.
    await tx.task.update({ where: { id: task.id }, data: { cycleStartedAt: null, cycleEndsAt: null } });
    return;
  }

  await tx.pendingCredit.deleteMany({ where: { taskId: task.id } });
  await tx.subtask.updateMany({ where: { taskId: task.id }, data: UNCHECKED });
  await tx.recurrenceRule.update({ where: { id: task.recurrence.id }, data: { nextRunAt: dueDate } });
  const assigneeId = await rotatedAssignee(tx, householdId, task, ended);
  await tx.task.update({
    where: { id: task.id },
    data: { status: 'pending', completedAt: null, dueDate, cycleStartedAt: start, cycleEndsAt: end, assigneeId },
  });
  if (missed > 0) {
    await logActivity(
      {
        householdId,
        actorId: null,
        verb: 'missed',
        subjectType: 'task',
        subjectId: task.id,
        message: `missed task “${task.title}”${missed > 1 ? ` (${missed} cycles)` : ''}`,
      },
      tx,
    );
  }
}

// --- Points on save ---------------------------------------------------------------

type EditorStep = StepPoints & { title: string; resetIntervalDays: number | null; done: boolean; id?: string };

/** The points state an editor save describes, with missing values filled in. */
function stateFromInput(
  base: { estimatedMinutes?: number | null; points?: number | null; pointsFollowTime?: boolean },
  steps: SubtaskInput[],
  minutesPerPoint: number,
): PointsState<EditorStep> {
  const follow = base.pointsFollowTime ?? (base.points === undefined || base.points === null);
  const baseMinutes = base.estimatedMinutes ?? null;
  const filled = withDefaults(
    {
      baseMinutes,
      basePointsCenti: follow || base.points == null ? null : toCenti(base.points),
      pointsFollowTime: follow,
    },
    steps.map((s) => ({
      id: s.id,
      title: s.title,
      resetIntervalDays: s.resetIntervalDays ?? null,
      done: s.done,
      minutes: s.minutes,
      pointsCenti: s.points === undefined ? undefined : toCenti(s.points),
      minutesCustom: s.minutesCustom,
      pointsFollowTime: s.pointsFollowTime,
    })),
    minutesPerPoint,
  );
  // withDefaults treats a missing base-points value as "follows time"; keep
  // the caller's explicit choice.
  return { task: { ...filled.task, pointsFollowTime: follow }, steps: filled.steps };
}

/** Task columns for a points state: base values and live totals. */
function taskPointsColumns(state: PointsState) {
  const live = liveTotals(state);
  return {
    baseMinutes: state.task.baseMinutes,
    basePointsCenti: state.task.basePointsCenti,
    pointsFollowTime: state.task.pointsFollowTime,
    estimatedMinutes: state.task.baseMinutes === null && live.minutes === 0 ? null : live.minutes,
    pointsCenti: live.pointsCenti,
  };
}

function stepPointsColumns(s: StepPoints) {
  return {
    minutes: s.minutes,
    pointsCenti: s.pointsCenti,
    minutesCustom: s.minutesCustom,
    pointsFollowTime: s.pointsFollowTime,
  };
}

/** Writes every step's values and the task's totals for `state` (steps in
 *  checklist order, matching `ids`). */
async function writePoints(tx: Tx, taskId: string, ids: string[], state: PointsState) {
  for (const [i, id] of ids.entries()) {
    await tx.subtask.update({ where: { id }, data: stepPointsColumns(state.steps[i]) });
  }
  await tx.task.update({ where: { id: taskId }, data: taskPointsColumns(state) });
}

// --- Tasks --------------------------------------------------------------------------

export async function createTask(
  householdId: string,
  userId: string,
  input: CreateTaskInput,
): Promise<TaskWithRelations> {
  const settings = await getPointsSettings(householdId);
  const state = stateFromInput(input, input.subtasks ?? [], settings.minutesPerPoint);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const rotation = await rotationColumns(tx, householdId, input.rotationUserIds ?? null, input.assigneeId ?? null, null);
    let rule: RuleRow | null = null;
    if (input.recurrence) {
      rule = await tx.recurrenceRule.create({
        data: recurrenceData(input.recurrence, input.dueDate),
      });
    }

    const task = await tx.task.create({
      data: {
        householdId,
        title: input.title,
        notes: input.notes ?? null,
        type: input.recurrence ? 'recurring' : input.type,
        priority: input.priority,
        dueDate: input.dueDate ?? null,
        ...taskPointsColumns(state),
        ...cycleWindow(rule, settings.timezone, now),
        categoryId: input.categoryId ?? null,
        assigneeId: rotation.assigneeId ?? null,
        rotationUserIds: rotation.rotationUserIds,
        createdById: userId,
        recurrenceId: rule?.id,
        subtasks: state.steps.length
          ? {
              create: state.steps.map((s, i) => ({
                title: s.title,
                done: s.done,
                doneAt: s.done ? now : null,
                doneById: s.done ? userId : null,
                resetIntervalDays: s.resetIntervalDays,
                position: i,
                ...stepPointsColumns(s),
              })),
            }
          : undefined,
      },
      include: taskInclude,
    });
    // Steps created already checked queue their points like any other check.
    const prechecked = task.subtasks.filter((s) => s.done);
    if (prechecked.length) {
      await tx.pendingCredit.createMany({
        data: prechecked.map((s) => ({
          householdId,
          taskId: task.id,
          subtaskId: s.id,
          userId,
          checkedAt: now,
          cycleStartedAt: task.cycleStartedAt,
        })),
      });
    }

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
 * Queued points survive this reset; `autoResetAt` lets the next check pay out.
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
    data: { ...UNCHECKED, autoResetAt: new Date(now) },
  });
  return count;
}

export async function listTasks(
  householdId: string,
  query: ListTasksQuery,
): Promise<TaskWithRelations[]> {
  await rollTaskCycles(householdId);
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
  const { taskId, recurrence, subtasks, rotationUserIds, ...rest } = input;
  const settings = await getPointsSettings(householdId);
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    // Scope the update to the household so members can't touch other households.
    const existing = await tx.task.findFirst({
      where: { id: taskId, householdId },
      include: { subtasks: { orderBy: { position: 'asc' } }, recurrence: true },
    });
    if (!existing) throw new TaskNotFoundError(taskId);

    let recurrenceId: string | null | undefined; // undefined = unchanged
    let typeOverride: string | undefined;
    let rule: RuleRow | null = existing.recurrence;

    if (recurrence === null) {
      // Clear recurrence: the task becomes a one-time task.
      recurrenceId = null;
      rule = null;
      if (rest.type === undefined) typeOverride = 'one_time';
    } else if (recurrence) {
      const dueDate = rest.dueDate ?? existing.dueDate;
      const data = recurrenceData(recurrence, dueDate);
      if (existing.recurrenceId) {
        rule = await tx.recurrenceRule.update({
          where: { id: existing.recurrenceId },
          data,
        });
      } else {
        rule = await tx.recurrenceRule.create({ data });
        recurrenceId = rule.id;
      }
      if (rest.type === undefined) typeOverride = 'recurring';
    }

    // Cycles: (re)start the window when cycling was switched on or its days
    // changed; clear it when switched off.
    let cycle: { cycleStartedAt: Date | null; cycleEndsAt: Date | null } | undefined;
    if (recurrence !== undefined) {
      const before = JSON.stringify(cycleSpecFor(existing.recurrence));
      const after = JSON.stringify(cycleSpecFor(rule));
      if (before !== after) cycle = cycleWindow(rule, settings.timezone, now);
    }

    // Points. A full checklist from the editor carries its own values;
    // otherwise a changed base is redistributed here (older clients).
    if (subtasks) {
      await replaceChecklist(tx, householdId, existing, subtasks, userId, now);
      const state = stateFromInput(
        {
          estimatedMinutes: rest.estimatedMinutes !== undefined ? rest.estimatedMinutes : existing.baseMinutes ?? existing.estimatedMinutes,
          points:
            rest.points !== undefined
              ? rest.points
              : existing.basePointsCenti == null
                ? null
                : existing.basePointsCenti / 100,
          pointsFollowTime: rest.pointsFollowTime ?? existing.pointsFollowTime ?? true,
        },
        subtasks,
        settings.minutesPerPoint,
      );
      const ids = (
        await tx.subtask.findMany({ where: { taskId }, orderBy: { position: 'asc' }, select: { id: true } })
      ).map((s) => s.id);
      await writePoints(tx, taskId, ids, state);
    } else {
      let state: PointsState = effectivePoints(existing, settings.minutesPerPoint);
      const live = liveTotals(state);
      let changed = false;
      // An older app re-sends the live total it was shown: not a change.
      if (rest.estimatedMinutes !== undefined && rest.estimatedMinutes !== live.minutes && rest.estimatedMinutes !== state.task.baseMinutes) {
        state = setTaskMinutes(state, rest.estimatedMinutes, settings.minutesPerPoint, { confirm: true }).state;
        changed = true;
      }
      if (rest.pointsFollowTime === true && !state.task.pointsFollowTime) {
        state = setTaskFollow(state, true, settings.minutesPerPoint, { confirm: true }).state;
        changed = true;
      }
      if (rest.points !== undefined && rest.points !== null && rest.pointsFollowTime !== true) {
        state = setTaskPoints(state, toCenti(rest.points), { confirm: true }).state;
        changed = true;
      }
      if (changed) await writePoints(tx, taskId, existing.subtasks.map((s) => s.id), state);
    }

    // Rotation: saving a list puts the assignee on it (whose turn it is now).
    // Without one (older clients), a hand-picked assignee is taken as is —
    // someone covering a turn; the next turn then starts the list over.
    const assignment =
      rotationUserIds !== undefined
        ? await rotationColumns(tx, householdId, rotationUserIds, rest.assigneeId, existing.assigneeId)
        : { assigneeId: rest.assigneeId };

    const task = await tx.task.update({
      where: { id: taskId },
      data: {
        title: rest.title,
        notes: rest.notes,
        type: rest.type ?? typeOverride,
        priority: rest.priority,
        status: rest.status,
        dueDate: rest.dueDate,
        categoryId: rest.categoryId,
        ...assignment,
        recurrenceId,
        ...(cycle ?? {}),
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

/**
 * Make the checklist match the editor's list: items with a known id are
 * updated (done state is left alone — ticking goes through updateSubtask),
 * new ones created, missing ones deleted with their queued points. Order =
 * array order.
 */
async function replaceChecklist(
  tx: Tx,
  householdId: string,
  existing: { id: string; cycleStartedAt: Date | null; subtasks: { id: string }[] },
  items: SubtaskInput[],
  userId: string,
  now: Date,
) {
  const known = new Set(existing.subtasks.map((s) => s.id));
  const keep = new Set(items.map((i) => i.id).filter((id): id is string => !!id && known.has(id)));
  const removed = [...known].filter((id) => !keep.has(id));
  if (removed.length) {
    await tx.pendingCredit.deleteMany({ where: { subtaskId: { in: removed } } });
    await tx.subtask.deleteMany({ where: { id: { in: removed } } });
  }
  for (const [position, item] of items.entries()) {
    if (item.id && keep.has(item.id)) {
      await tx.subtask.update({
        where: { id: item.id },
        data: { title: item.title, resetIntervalDays: item.resetIntervalDays ?? null, position },
      });
    } else {
      const created = await tx.subtask.create({
        data: {
          taskId: existing.id,
          title: item.title,
          resetIntervalDays: item.resetIntervalDays ?? null,
          position,
          done: item.done,
          doneAt: item.done ? now : null,
          doneById: item.done ? userId : null,
        },
      });
      if (item.done) {
        await tx.pendingCredit.create({
          data: { householdId, taskId: existing.id, subtaskId: created.id, userId, checkedAt: now, cycleStartedAt: existing.cycleStartedAt },
        });
      }
    }
  }
}

/**
 * Complete a task and pay out its points (see pointsService). For recurring
 * tasks this records the completion, then:
 * - with cycles, the task is done for this cycle (status completed) and
 *   reopens at the next cycle start (rollTaskCycles);
 * - without, it rolls forward to its next occurrence (due date advances,
 *   status returns to pending) as before.
 * One-time tasks — and recurring tasks whose `until` end date has been
 * reached — are marked completed. Steps left unchecked are checked by the
 * completer (they "finish the rest").
 *
 * Guests hold `tasks:complete` but only for tasks assigned to them (see
 * src/lib/permissions.ts) — that narrower scope is enforced here.
 */
export async function completeTask(
  householdId: string,
  actor: CompletingActor,
  input: CompleteTaskInput,
): Promise<{ task: TaskWithRelations; completionId: string }> {
  const userId = actor.id;
  await rollTaskCycles(householdId, new Date(), input.taskId);
  const settings = await getPointsSettings(householdId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.task.findFirst({
      where: { id: input.taskId, householdId },
      include: { recurrence: true, subtasks: { orderBy: { position: 'asc' } } },
    });
    if (!existing) {
      throw new TaskNotFoundError(input.taskId);
    }

    if (actor.role === 'guest' && existing.assigneeId !== actor.id) {
      throw new ForbiddenError(
        'Guests may only complete tasks assigned to them.',
      );
    }
    if (existing.status === 'completed' || existing.status === 'archived') {
      throw new ConflictError(
        existing.cycleEndsAt ? 'This task is already done for this cycle.' : 'This task is already completed.',
      );
    }

    const now = new Date();
    const pending = await tx.pendingCredit.findMany({ where: { taskId: existing.id } });
    const pendingBy = new Map(pending.map((p) => [p.subtaskId, p]));
    const state = effectivePoints(existing, settings.minutesPerPoint);
    const snapshot: CompletionSnapshot = {
      status: existing.status,
      completedAt: existing.completedAt?.toISOString() ?? null,
      dueDate: existing.dueDate?.toISOString() ?? null,
      nextRunAt: existing.recurrence?.nextRunAt?.toISOString() ?? null,
      cycleStartedAt: existing.cycleStartedAt?.toISOString() ?? null,
      cycleEndsAt: existing.cycleEndsAt?.toISOString() ?? null,
      assigneeId: existing.assigneeId,
      steps: existing.subtasks.map((s) => ({
        id: s.id,
        done: s.done,
        doneAt: s.doneAt?.toISOString() ?? null,
        doneById: s.doneById,
        checkAwardId: s.checkAwardId,
        autoResetAt: s.autoResetAt?.toISOString() ?? null,
      })),
      pending: pending.map((p) => ({
        subtaskId: p.subtaskId,
        userId: p.userId,
        checkedAt: p.checkedAt.toISOString(),
        cycleStartedAt: p.cycleStartedAt?.toISOString() ?? null,
      })),
    };

    const completion = await tx.taskCompletion.create({
      data: {
        taskId: existing.id,
        userId,
        note: input.note ?? null,
        outcome: 'completed',
        completedAt: now,
        snapshot: JSON.stringify(snapshot),
      },
    });

    const awards = planPayout({
      taskPointsCenti: liveTotals(state).pointsCenti,
      steps: existing.subtasks.map((s, i) => {
        const p = pendingBy.get(s.id);
        return {
          id: s.id,
          title: s.title,
          pointsCenti: state.steps[i].pointsCenti,
          pending: p ? { userId: p.userId, checkedAt: p.checkedAt } : null,
        };
      }),
      completerId: userId,
      now,
    });
    await writeAwards(tx, { householdId, taskId: existing.id, taskTitle: existing.title, completionId: completion.id, now }, awards);
    await tx.pendingCredit.deleteMany({ where: { taskId: existing.id } });
    // Rows from before points get their values written now, so what was paid
    // matches what the task shows from here on.
    await writePoints(tx, existing.id, existing.subtasks.map((s) => s.id), state);

    const next = existing.recurrence && !existing.cycleEndsAt
      ? computeNextRunAt(normalizeRule(existing.recurrence), now)
      : null;
    // A supported recurring rule that yields no next occurrence has reached its
    // `until` end date and should finalize. (cron yields null but isn't ended.)
    const recurrenceEnded =
      !!existing.recurrence && !existing.cycleEndsAt && existing.recurrence.kind !== 'cron' && next === null;
    const finishSteps = () =>
      tx.subtask.updateMany({
        where: { taskId: existing.id, done: false },
        data: { done: true, doneAt: now, doneById: userId, checkAwardId: null, autoResetAt: null },
      });

    let task: TaskWithRelations;
    if (existing.recurrence && existing.cycleEndsAt) {
      // Done for this cycle; rollTaskCycles reopens it at the next start.
      await finishSteps();
      task = await tx.task.update({
        where: { id: existing.id },
        data: { status: 'completed', completedAt: now },
        include: taskInclude,
      });
    } else if (existing.recurrence && !recurrenceEnded) {
      await tx.recurrenceRule.update({
        where: { id: existing.recurrence.id },
        data: { nextRunAt: next },
      });
      // The task starts its next occurrence fresh: uncheck the whole checklist,
      // and a rotating task passes to the next person.
      await tx.subtask.updateMany({ where: { taskId: existing.id }, data: UNCHECKED });
      task = await tx.task.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          completedAt: null,
          dueDate: next ?? existing.dueDate,
          assigneeId: await rotatedAssignee(tx, householdId, existing, 1),
        },
        include: taskInclude,
      });
    } else {
      await finishSteps();
      task = await tx.task.update({
        where: { id: existing.id },
        data: { status: 'completed', completedAt: now },
        include: taskInclude,
      });
    }

    const paid = awards.reduce((a, w) => a + w.pointsCenti, 0);
    await logActivity(
      {
        householdId,
        actorId: userId,
        verb: 'completed',
        subjectType: 'task',
        subjectId: task.id,
        message: `completed task “${task.title}”${paid > 0 ? ` (${formatPoints(paid)} pts)` : ''}`,
        metadata: input.note ? { note: input.note } : undefined,
      },
      tx,
    );

    return { task, completionId: completion.id };
  });
}

/**
 * Undo a completion: restore the task as it was just before and void the
 * points it paid. The completer may within UNDO_WINDOW_MS, the head any time
 * — but only for the task's latest completion, and only while nothing has
 * happened on the task since (otherwise the head voids points in the ledger).
 */
export async function undoCompletion(
  householdId: string,
  actor: CompletingActor,
  completionId: string,
): Promise<TaskWithRelations> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const completion = await tx.taskCompletion.findFirst({
      where: { id: completionId, task: { householdId } },
      include: { task: { include: { recurrence: true, subtasks: true } } },
    });
    if (!completion) throw new NotFoundError('Completion not found.');
    if (completion.undoneAt) throw new ConflictError('This completion was already undone.');
    if (completion.outcome === 'missed') throw new ConflictError('A missed cycle can’t be undone.');
    if (!canUndo({ completedById: completion.userId, completedAt: completion.completedAt, actor, now })) {
      throw new ForbiddenError('Only the head can undo this now (the 10-minute window has passed).');
    }
    if (!completion.snapshot) {
      throw new ConflictError('This completion is from before undo existed; ask the head to void its points.');
    }

    const task = completion.task;
    const later = await tx.taskCompletion.count({
      where: {
        taskId: task.id,
        id: { not: completion.id },
        completedAt: { gte: completion.completedAt },
        OR: [{ undoneAt: null }, { undoneAt: { isSet: false } }],
      },
    });
    const at = completion.completedAt.getTime();
    const touched =
      task.subtasks.some((s) => (s.doneAt?.getTime() ?? 0) > at || (s.autoResetAt?.getTime() ?? 0) > at) ||
      (await tx.pendingCredit.count({ where: { taskId: task.id, checkedAt: { gt: completion.completedAt } } })) > 0;
    const snapshot = JSON.parse(completion.snapshot) as CompletionSnapshot;
    const rolled = (task.cycleStartedAt?.toISOString() ?? null) !== snapshot.cycleStartedAt;
    if (later > 0 || touched || rolled) {
      throw new ConflictError('The task has changed since it was completed; ask the head to void the points instead.');
    }

    const date = (v: string | null) => (v ? new Date(v) : null);
    for (const s of snapshot.steps) {
      if (!task.subtasks.some((t) => t.id === s.id)) continue;
      await tx.subtask.update({
        where: { id: s.id },
        data: {
          done: s.done,
          doneAt: date(s.doneAt),
          doneById: s.doneById,
          checkAwardId: s.checkAwardId,
          autoResetAt: date(s.autoResetAt),
        },
      });
    }
    await tx.pendingCredit.deleteMany({ where: { taskId: task.id } });
    const liveSteps = new Set(task.subtasks.map((s) => s.id));
    const restore = snapshot.pending.filter((p) => liveSteps.has(p.subtaskId));
    if (restore.length) {
      await tx.pendingCredit.createMany({
        data: restore.map((p) => ({
          householdId,
          taskId: task.id,
          subtaskId: p.subtaskId,
          userId: p.userId,
          checkedAt: new Date(p.checkedAt),
          cycleStartedAt: date(p.cycleStartedAt),
        })),
      });
    }
    if (task.recurrence) {
      await tx.recurrenceRule.update({ where: { id: task.recurrence.id }, data: { nextRunAt: date(snapshot.nextRunAt) } });
    }
    await tx.pointAward.updateMany({
      where: { completionId: completion.id, OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }] },
      data: { voidedAt: now, voidedById: actor.id, voidReason: 'Completion undone' },
    });
    await tx.taskCompletion.update({ where: { id: completion.id }, data: { undoneAt: now, undoneById: actor.id } });
    const restored = await tx.task.update({
      where: { id: task.id },
      data: {
        status: snapshot.status,
        completedAt: date(snapshot.completedAt),
        dueDate: date(snapshot.dueDate),
        // A rotation that moved on completing moves back (absent in older snapshots).
        ...(snapshot.assigneeId !== undefined ? { assigneeId: snapshot.assigneeId } : {}),
      },
      include: taskInclude,
    });
    await logActivity(
      {
        householdId,
        actorId: actor.id,
        verb: 'updated',
        subjectType: 'task',
        subjectId: task.id,
        message: `undid completing task “${task.title}”`,
      },
      tx,
    );
    return restored;
  });
}

/** Completion history for a task, newest first, as the caller sees it. */
export async function listTaskCompletions(
  householdId: string,
  taskId: string,
  actor: CompletingActor,
  limit = 20,
): Promise<TaskCompletionDTO[]> {
  await assertTaskInHousehold(taskId, householdId);
  const rows = await prisma.taskCompletion.findMany({
    where: { taskId },
    include: { user: { select: { id: true, name: true } } },
    orderBy: { completedAt: 'desc' },
    take: limit,
  });
  const sums = await prisma.pointAward.groupBy({
    by: ['completionId'],
    where: {
      completionId: { in: rows.map((r) => r.id) },
      OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }],
    },
    _sum: { pointsCenti: true },
  });
  const paid = new Map(sums.map((s) => [s.completionId, s._sum.pointsCenti ?? 0]));
  const now = new Date();
  // Only the newest live completion can be undone.
  const latestLive = rows.find((r) => !r.undoneAt && r.outcome !== 'missed');
  return rows.map((c) => ({
    id: c.id,
    note: c.note,
    completedAt: c.completedAt.toISOString(),
    user: c.user ? { id: c.user.id, name: c.user.name } : null,
    outcome: c.outcome ?? 'completed',
    undoneAt: c.undoneAt?.toISOString() ?? null,
    points: (paid.get(c.id) ?? 0) / 100,
    canUndo:
      c === latestLive &&
      !!c.snapshot &&
      canUndo({ completedById: c.userId, completedAt: c.completedAt, actor, now }),
  }));
}

/**
 * Permanently delete a task. Completions and subtasks cascade via their DB
 * relation, but the recurrence rule is the FK parent (Task.recurrenceId ->
 * SetNull on delete) so it is removed explicitly to avoid orphaning it. Queued
 * points are dropped; paid points stay in the ledger (it keeps the title).
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

    await tx.pendingCredit.deleteMany({ where: { taskId: existing.id } });
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

/** Add a step; its time/points come from the task's split rules (addStep). */
export async function addSubtask(
  householdId: string,
  input: CreateSubtaskInput,
): Promise<TaskWithRelations> {
  await assertTaskInHousehold(input.taskId, householdId);
  const settings = await getPointsSettings(householdId);
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirstOrThrow({
      where: { id: input.taskId },
      include: { subtasks: { orderBy: { position: 'asc' } } },
    });
    const state = addStep(effectivePoints(task, settings.minutesPerPoint), {});
    const created = await tx.subtask.create({
      data: {
        taskId: input.taskId,
        title: input.title,
        resetIntervalDays: input.resetIntervalDays ?? null,
        position: task.subtasks.length,
      },
    });
    await writePoints(tx, task.id, [...task.subtasks.map((s) => s.id), created.id], state);
  });
  return getTaskOrThrow(householdId, input.taskId);
}

/**
 * Edit a step's title/order/reset, or check/uncheck it — which is where step
 * points are queued or paid (checkOutcome) and dropped on a hand uncheck.
 */
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
  if (input.done !== undefined) {
    await rollTaskCycles(householdId, new Date(), taskId);
    await setStepDone(householdId, taskId, input.subtaskId, input.done, actor ?? null);
  }
  if (input.title !== undefined || input.position !== undefined || input.resetIntervalDays !== undefined) {
    await prisma.subtask.update({
      where: { id: input.subtaskId },
      data: {
        title: input.title,
        position: input.position,
        resetIntervalDays: input.resetIntervalDays,
      },
    });
  }
  return getTaskOrThrow(householdId, taskId);
}

async function setStepDone(
  householdId: string,
  taskId: string,
  subtaskId: string,
  done: boolean,
  actor: CompletingActor | null,
) {
  const settings = await getPointsSettings(householdId);
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirstOrThrow({
      where: { id: taskId },
      include: { subtasks: { orderBy: { position: 'asc' } } },
    });
    const index = task.subtasks.findIndex((s) => s.id === subtaskId);
    const step = task.subtasks[index];
    const pending = await tx.pendingCredit.findUnique({ where: { subtaskId } });

    if (done) {
      if (step.done) return;
      const outcome = actor
        ? checkOutcome({
            alreadyDone: step.done,
            taskFinished: task.status === 'completed',
            hasPending: !!pending,
            autoReset: !!step.autoResetAt,
          })
        : 'nothing';
      let checkAwardId: string | null = null;
      if (outcome === 'queue') {
        await tx.pendingCredit.create({
          data: { householdId, taskId, subtaskId, userId: actor!.id, checkedAt: now, cycleStartedAt: task.cycleStartedAt },
        });
      } else if (outcome === 'pay_now') {
        const points = effectivePoints(task, settings.minutesPerPoint).steps[index].pointsCenti;
        if (points > 0) {
          const award = await tx.pointAward.create({
            data: {
              householdId,
              userId: actor!.id,
              taskId,
              subtaskId,
              kind: 'step_repeat',
              pointsCenti: points,
              taskTitle: task.title,
              stepTitle: step.title,
              earnedAt: now,
              awardedAt: now,
            },
          });
          checkAwardId = award.id;
        }
      }
      await tx.subtask.update({
        where: { id: subtaskId },
        data: { done: true, doneAt: now, doneById: actor?.id ?? null, checkAwardId, autoResetAt: null },
      });
      return;
    }

    if (!step.done) return;
    if (step.checkAwardId) {
      // This check paid at once: unchecking it within the undo window (by the
      // same person, or the head) takes the points back.
      const award = await tx.pointAward.findUnique({ where: { id: step.checkAwardId } });
      if (
        award &&
        !award.voidedAt &&
        actor &&
        (actor.role === 'head' || (award.userId === actor.id && now.getTime() - award.awardedAt.getTime() <= UNDO_WINDOW_MS))
      ) {
        await tx.pointAward.update({
          where: { id: award.id },
          data: { voidedAt: now, voidedById: actor.id, voidReason: 'Step unchecked' },
        });
      }
    } else if (pending) {
      // Unchecked by hand: its queued points are dropped.
      await tx.pendingCredit.delete({ where: { id: pending.id } });
    }
    await tx.subtask.update({ where: { id: subtaskId }, data: UNCHECKED });
  });
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

/** Remove a step: its share goes back to the others or the totals shrink
 *  (removeStep); its queued points are dropped. */
export async function deleteSubtask(
  householdId: string,
  subtaskId: string,
): Promise<TaskWithRelations> {
  const taskId = await assertSubtaskInHousehold(subtaskId, householdId);
  const settings = await getPointsSettings(householdId);
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirstOrThrow({
      where: { id: taskId },
      include: { subtasks: { orderBy: { position: 'asc' } } },
    });
    const index = task.subtasks.findIndex((s) => s.id === subtaskId);
    const state = removeStep(effectivePoints(task, settings.minutesPerPoint), index);
    await tx.pendingCredit.deleteMany({ where: { subtaskId } });
    await tx.subtask.delete({ where: { id: subtaskId } });
    await writePoints(tx, taskId, task.subtasks.filter((s) => s.id !== subtaskId).map((s) => s.id), state);
  });
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
