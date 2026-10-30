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
  ReorderTasksInput,
  SubtaskInput,
  UpdateSubtaskInput,
  UpdateTaskInput,
} from '@/lib/validation/task';
import { logActivity } from '@/server/services/activityService';
import { assertCategoryRef, assertMemberRef, assertPlaceRefs } from '@/server/services/householdRefs';
import {
  placeColumns,
  placeListColumns,
  samePlaces,
  taskPlaceIds,
  type PlaceIds,
} from '@/lib/places';
import { loadPlaceIndex, resolveTaskPlaces, type PlaceIndex } from '@/server/services/taskPlaces';
import {
  MAX_WAITING_CHECKS,
  PHOTO_KEEP_MS,
  TASK_REVIEWED_TYPE,
  TASK_REVIEW_TYPE,
  ALREADY_WAITING,
  TOO_MANY_WAITING,
  WAITING_FOR_OK,
  addStepEntries,
  askSupervisors,
  checkConflict,
  clearChildBell,
  clearReviewBells,
  currentSupervisors,
  dropStepEntries,
  healAwaitingReview,
  isSupervisedChild,
  isWaitingKeyClash,
  mayUndoCheck,
  needsCheck,
  parseEntries,
  retryOnWaitingClash,
  startedWaiting,
  statusBefore,
  stoppedWaiting,
  supervisedNow,
  supervisesNow,
  tellChild,
  waitingCheck,
  waitingKey,
  waitingSteps,
  wakeForChecks,
  withdrawInTx,
  type StoredEntry,
} from '@/server/services/taskReviewService';
import { rebuildJpeg, type RebuiltJpeg } from '@/server/security/jpeg';
import { canBeSupervised } from '@/lib/permissions';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '@/server/services/errors';
import {
  completeOccurrence,
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
  announceTaskReady,
  clearTaskReady,
  pushTaskReady,
} from '@/server/services/taskReadyService';
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
  room: { select: { id: true, name: true, floor: { select: { id: true, name: true } } } },
  floor: { select: { id: true, name: true } },
  assignee: { select: { id: true, name: true } },
  recurrence: true,
  subtasks: { orderBy: { position: 'asc' } },
} satisfies Prisma.TaskInclude;

export type TaskWithRelations = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
type Tx = Prisma.TransactionClient;
type RuleRow = NonNullable<TaskWithRelations['recurrence']>;

/** Who is acting on a task; the role narrows what guests may do. */
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
  /** The household's floors and rooms, for each task's places. */
  places: PlaceIndex;
  /** taskId → its waiting "task" check (Task Photo Proof), if any. */
  waiting: Map<string, { id: string; userId: string; submittedAt: Date; cycleEndsAt: Date | null }>;
  /** `${subtaskId}|${checkedAt ISO}` of each step tick waiting for an OK in a "steps" check. */
  stepsWaiting: Set<string>;
  /** Who the DTOs are for (review.checkForMe, review.submissionId); null = nobody in particular. */
  viewer: TaskViewer | null;
}

/** The member reading the tasks, read once per list (never once per task). */
interface TaskViewer {
  id: string;
  /** needsCheck for them on a task that asks for a photo, and on one that doesn't. */
  checkPhoto: boolean;
  checkPlain: boolean;
  /** The children they look after right now (whose waiting checks they may open). */
  supervises: Set<string>;
}

/**
 * needsCheck for [viewerId], asked once for a whole list: it reads the task
 * only for photoProof, so two answers cover every task. Without a photo asked
 * it also needs "Check their tasks before points", so it can only hold when
 * the photo answer does.
 */
async function viewerChecks(householdId: string, viewerId: string): Promise<{ checkPhoto: boolean; checkPlain: boolean }> {
  const checkPhoto = await needsCheck(prisma, householdId, viewerId, { photoProof: true });
  const checkPlain = checkPhoto && (await needsCheck(prisma, householdId, viewerId, { photoProof: null }));
  return { checkPhoto, checkPlain };
}

/**
 * What the task DTOs need beyond the rows. [viewerId]: the member they are
 * for; without one, review.checkForMe is false and review.submissionId null.
 */
export async function loadTaskContext(householdId: string, taskIds: string[], viewerId?: string): Promise<TaskContext> {
  const [settings, members, pending, places, waiting, stepChecks, checks] = await Promise.all([
    getPointsSettings(householdId),
    prisma.user.findMany({ where: { householdId }, select: { id: true, name: true } }),
    taskIds.length
      ? prisma.pendingCredit.findMany({ where: { householdId, taskId: { in: taskIds } } })
      : Promise.resolve([]),
    loadPlaceIndex(prisma, householdId),
    taskIds.length
      ? prisma.taskSubmission.findMany({
          where: { householdId, taskId: { in: taskIds }, kind: 'task', status: 'waiting' },
          select: { id: true, taskId: true, userId: true, submittedAt: true, cycleEndsAt: true },
        })
      : Promise.resolve([]),
    taskIds.length
      ? prisma.taskSubmission.findMany({
          where: { householdId, taskId: { in: taskIds }, kind: 'steps', status: 'waiting' },
          select: { entries: true },
        })
      : Promise.resolve([]),
    viewerId && taskIds.length ? viewerChecks(householdId, viewerId) : null,
  ]);
  // Only asked when someone else's check waits in the list: the viewer's own
  // need no supervision read.
  const supervises =
    viewerId && waiting.some((w) => w.userId !== viewerId)
      ? await supervisedNow(prisma, householdId, viewerId)
      : new Set<string>();
  return {
    settings,
    names: new Map(members.map((m) => [m.id, m.name])),
    pending: new Map(pending.map((p) => [p.subtaskId, p.userId])),
    places,
    waiting: new Map(waiting.map((w) => [w.taskId, w])),
    stepsWaiting: new Set(stepChecks.flatMap((c) => parseEntries(c.entries).map((e) => `${e.subtaskId}|${e.checkedAt}`))),
    viewer: viewerId
      ? { id: viewerId, checkPhoto: checks?.checkPhoto ?? false, checkPlain: checks?.checkPlain ?? false, supervises }
      : null,
  };
}

/**
 * The places an input asks for, or undefined to leave them. The lists
 * replace every place; a single roomId/floorId (app builds that know one
 * place) replaces only the first and keeps the rest of `current`.
 */
function inputPlaces(
  input: { roomIds?: string[]; floorIds?: string[]; roomId?: string | null; floorId?: string | null },
  current: PlaceIds[],
): PlaceIds[] | undefined {
  if (input.roomIds !== undefined || input.floorIds !== undefined) {
    return [
      ...(input.roomIds ?? []).map((roomId) => ({ roomId, floorId: null })),
      ...(input.floorIds ?? []).map((floorId) => ({ roomId: null, floorId })),
    ];
  }
  if (input.roomId !== undefined || input.floorId !== undefined) {
    const first = placeColumns(input.roomId, input.floorId);
    return [...(first.roomId || first.floorId ? [first] : []), ...current.slice(1)];
  }
  return undefined;
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
  const check = ctx.waiting.get(task.id);
  const viewer = ctx.viewer;
  // Whether Complete from this viewer goes through a check (needsCheck).
  const checkForMe = !!viewer && (task.photoProof === true ? viewer.checkPhoto : viewer.checkPlain);
  // The waiting check's id, for the child who sent it and the adults who look after them now.
  const submissionId =
    check && viewer && (check.userId === viewer.id || viewer.supervises.has(check.userId)) ? check.id : null;
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
    opensAt: task.opensAt?.toISOString() ?? null,
    category: task.category
      ? { id: task.category.id, name: task.category.name, color: task.category.color }
      : null,
    room: task.room ? { id: task.room.id, name: task.room.name } : null,
    // A room's floor comes from the room, so moving the room moves its tasks.
    floor: task.room
      ? task.room.floor
        ? { id: task.room.floor.id, name: task.room.floor.name }
        : null
      : task.floor
        ? { id: task.floor.id, name: task.floor.name }
        : null,
    places: resolveTaskPlaces(task, ctx.places),
    position: task.position ?? null,
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
      // Its current tick's points wait for an adult's OK ("Waiting for an OK").
      waitingForOk: s.done && !!s.doneAt && ctx.stepsWaiting.has(`${s.id}|${s.doneAt.toISOString()}`),
    })),
    photoProof: task.photoProof === true,
    // Who sent it and when, for everyone; the note and photo are only for the
    // child and their supervisors (GET /api/tasks/submissions).
    review: check
      ? {
          waiting: true,
          submittedBy: member(check.userId, ctx.names),
          submittedAt: check.submittedAt.toISOString(),
          decideBy: check.cycleEndsAt?.toISOString() ?? null,
          checkForMe,
          submissionId,
        }
      : { waiting: false, submittedBy: null, submittedAt: null, decideBy: null, checkForMe, submissionId: null },
  };
}

/** [viewerId]: the member it is for (review.checkForMe, review.submissionId). */
export async function taskDTO(householdId: string, task: TaskWithRelations, viewerId?: string): Promise<TaskDTO> {
  return taskToDTO(task, await loadTaskContext(householdId, [task.id], viewerId));
}

/** One context for the whole list, so the viewer's checks are read once. */
export async function taskDTOs(householdId: string, tasks: TaskWithRelations[], viewerId?: string): Promise<TaskDTO[]> {
  const ctx = await loadTaskContext(householdId, tasks.map((t) => t.id), viewerId);
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
}, timeZone?: string): NormalizedRule {
  return {
    kind: rule.kind as NormalizedRule['kind'],
    interval: rule.interval,
    byWeekday: parseIntList(rule.byWeekday),
    byMonthday: parseIntList(rule.byMonthday),
    cron: rule.cron,
    anchorDate: rule.anchorDate,
    until: rule.until,
    // The household's zone: occurrences keep their local time across DST.
    timeZone,
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
function dueInCycle(rule: RuleRow, start: Date, end: Date, timeZone: string): Date | null {
  const next = computeNextRunAt(normalizeRule(rule, timeZone), new Date(start.getTime() - 1));
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

export const UNCHECKED = { done: false, doneAt: null, doneById: null, checkAwardId: null, autoResetAt: null };

// --- Rotating assignees (src/lib/taskRotation.ts) ---------------------------------

/** In rotation order, the ids that are (still) household members. */
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

/** Cap on missed cycles recorded in one catch-up (e.g., after downtime). */
const MAX_MISSED_PER_ROLL = 60;

/**
 * Roll every task whose cycle has ended into its current cycle: a cycle that
 * ended unfinished is recorded as missed (one row per missed cycle), and its
 * queued points are dropped; steps uncheck, and the due date moves into the
 * new window. Runs from the reminder sweep and before task reads/changes.
 */
export async function rollTaskCycles(householdId: string, now = new Date(), taskId?: string): Promise<number> {
  const due = await prisma.task.findMany({
    where: {
      householdId,
      ...(taskId ? { id: taskId } : {}),
      // Archived tasks sit still (archiving also clears the window; this
      // covers rows archived before that).
      status: { not: 'archived' },
      cycleEndsAt: dateOnOrBefore(now),
    },
    select: { id: true },
  });
  if (due.length === 0) return 0;
  const settings = await getPointsSettings(householdId);
  const ready: (string | null)[] = [];
  const woken: string[] = [];
  for (const { id } of due) {
    try {
      // People whose check bells changed as the cycle ended, woken once it commits.
      const wake: string[] = [];
      ready.push(await prisma.$transaction((tx) => rollOne(tx, householdId, id, settings, now, wake)));
      woken.push(...wake);
    } catch (err) {
      // One bad task mustn't stop the others rolling over.
      if (taskId) throw err;
      console.error(`[tasks] rolling task ${id} over failed; retrying next sweep`, err);
    }
  }
  pushTaskReady(householdId, ready);
  wakeForChecks(householdId, woken);
  return due.length;
}

/** Rolls one task; returns who to alert that it's ready for them, if anyone. */
async function rollOne(
  tx: Tx,
  householdId: string,
  taskId: string,
  settings: PointsSettings,
  now: Date,
  wake: string[] = [],
): Promise<string | null> {
  const task = await tx.task.findFirst({
    where: { id: taskId, householdId },
    include: { recurrence: true },
  });
  // Re-check inside the transaction: a concurrent roll may have done it.
  if (!task?.cycleEndsAt || task.cycleEndsAt > now || task.status === 'archived') return null;
  // A check still waiting when its cycle ends is settled first, before
  // anything below can stop or count the task as missed: (1) a task left
  // waiting with nothing to wait for is opened again; (2) a real one is
  // counted as done (or taken back for a child who is gone); (3) whether the
  // ended cycle was finished follows from the status that leaves.
  let status = (await healAwaitingReview(tx, householdId, task)).status;
  if (status === 'awaiting_review') {
    status = await endCycleCheck(tx, householdId, task, settings, now, wake);
  }
  const spec = cycleSpecFor(task.recurrence);
  if (!spec || !task.recurrence) {
    await tx.task.update({ where: { id: task.id }, data: { cycleStartedAt: null, cycleEndsAt: null } });
    return null;
  }

  let end = task.cycleEndsAt;
  let unfinished = status === 'pending' || status === 'in_progress';
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
  const dueDate = dueInCycle(task.recurrence, start, end, settings.timezone);
  if (dueDate === null) {
    // The rule's end date passed: stop cycling and leave the task as it is.
    await tx.task.update({ where: { id: task.id }, data: { cycleStartedAt: null, cycleEndsAt: null } });
    return null;
  }

  await tx.pendingCredit.deleteMany({ where: { taskId: task.id } });
  await tx.subtask.updateMany({ where: { taskId: task.id }, data: UNCHECKED });
  await tx.recurrenceRule.update({ where: { id: task.recurrence.id }, data: { nextRunAt: dueDate } });
  const assigneeId = await rotatedAssignee(tx, householdId, task, ended);
  const rolled = await tx.task.update({
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
  // A new cycle is open: it's ready for whoever's turn it is.
  return announceTaskReady(tx, householdId, rolled, null, settings.timezone);
}

/**
 * The cycle of a task waiting for its check ended (rollOne): the check counts
 * as done, paid as the child sent it (auto_approved, "cycle_end"), so chores
 * and rotations never stall on an adult. For 3 days the adults can still
 * take its points back (To check). A child who is gone or no longer a teen or
 * child is never paid: the check is withdrawn and the task goes back as it
 * was, so the roll records the cycle as missed. Returns the task's status now.
 */
async function endCycleCheck(
  tx: Tx,
  householdId: string,
  task: { id: string; title: string },
  settings: PointsSettings,
  now: Date,
  wake: string[],
): Promise<string> {
  // healAwaitingReview just found it, in this transaction.
  const check = (await waitingCheck(tx, householdId, task.id))!;
  const supervisors = await currentSupervisors(tx, householdId, check.userId);
  wake.push(...supervisors);
  const child = await tx.user.findFirst({ where: { id: check.userId, householdId }, select: { id: true, role: true } });
  if (!child || !canBeSupervised(child.role)) {
    await withdrawInTx(tx, householdId, check, now);
    return statusBefore(check.prevStatus);
  }
  const paid = await payCheckInTx(tx, { householdId, check, child, settings, now, wake });
  await tx.taskSubmission.update({
    where: { id: check.id },
    data: {
      status: 'auto_approved',
      autoReason: 'cycle_end',
      decidedById: null,
      decidedAt: now,
      completionId: paid.completionId,
      takenBackAt: null,
      photoDeleteAt: new Date(now.getTime() + PHOTO_KEEP_MS),
      ...stoppedWaiting(check),
    },
  });
  await clearReviewBells(tx, householdId, check.id);
  await tellChild(tx, householdId, check, `Counted as done: ${task.title}`);
  wake.push(child.id);
  return paid.task.status;
}

/**
 * Pays an approved check (by an adult, or on its own): the task goes back to
 * how it was when sent, then the child completes it as of when they sent it,
 * with the points landing now (completeInTx with the check's id). The caller
 * records the decision on the check.
 */
export async function payCheckInTx(
  tx: Tx,
  opts: {
    householdId: string;
    check: { id: string; taskId: string; submittedAt: Date; prevStatus: string | null };
    child: CompletingActor;
    settings: PointsSettings;
    now: Date;
    /** See CompleteInTxOptions.wake. */
    wake?: string[];
  },
): Promise<CompleteInTxResult> {
  const { householdId, check, child, settings, now, wake } = opts;
  await tx.task.update({ where: { id: check.taskId }, data: { status: statusBefore(check.prevStatus) } });
  return completeInTx(tx, {
    householdId,
    completer: child,
    // No note: the child's note stays on the check, never in Activity.
    input: { taskId: check.taskId },
    settings,
    at: check.submittedAt,
    now,
    submissionId: check.id,
    wake,
  });
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

type TaskWithSteps = Prisma.TaskGetPayload<{ include: { subtasks: true } }>;
type PointsEdit = Pick<UpdateTaskInput, 'estimatedMinutes' | 'points' | 'pointsFollowTime'>;

/** The points state an editor save with its full checklist describes (updateTask); unsent base values stay. */
function checklistState(existing: TaskWithSteps, edit: PointsEdit, subtasks: SubtaskInput[], minutesPerPoint: number) {
  return stateFromInput(
    {
      estimatedMinutes: edit.estimatedMinutes !== undefined ? edit.estimatedMinutes : existing.baseMinutes ?? existing.estimatedMinutes,
      points:
        edit.points !== undefined
          ? edit.points
          : existing.basePointsCenti == null
            ? null
            : existing.basePointsCenti / 100,
      pointsFollowTime: edit.pointsFollowTime ?? existing.pointsFollowTime ?? true,
    },
    subtasks,
    minutesPerPoint,
  );
}

/**
 * A save without the checklist (older clients): a changed base is
 * redistributed over the steps. `changed`: there is something to write.
 */
function baseEditState(existing: TaskWithSteps, edit: PointsEdit, minutesPerPoint: number): { state: PointsState; changed: boolean } {
  let state: PointsState = effectivePoints(existing, minutesPerPoint);
  const live = liveTotals(state);
  let changed = false;
  // An older app re-sends the live total it was shown: not a change.
  if (edit.estimatedMinutes !== undefined && edit.estimatedMinutes !== live.minutes && edit.estimatedMinutes !== state.task.baseMinutes) {
    state = setTaskMinutes(state, edit.estimatedMinutes, minutesPerPoint, { confirm: true }).state;
    changed = true;
  }
  if (edit.pointsFollowTime === true && !state.task.pointsFollowTime) {
    state = setTaskFollow(state, true, minutesPerPoint, { confirm: true }).state;
    changed = true;
  }
  if (edit.points !== undefined && edit.points !== null && edit.pointsFollowTime !== true) {
    state = setTaskPoints(state, toCenti(edit.points), { confirm: true }).state;
    changed = true;
  }
  return { state, changed };
}

/** Whether two points states pay and take the same: the task's base values and every step's. */
function samePoints(a: PointsState, b: PointsState): boolean {
  const task = (s: PointsState) => [s.task.baseMinutes, s.task.basePointsCenti, s.task.pointsFollowTime];
  const steps = (s: PointsState) => s.steps.map((x) => [x.minutes, x.pointsCenti, x.minutesCustom, x.pointsFollowTime]);
  return JSON.stringify([task(a), steps(a)]) === JSON.stringify([task(b), steps(b)]);
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

/**
 * Hand-set order of the tasks in one place: positions = array index. Ids
 * outside the household are ignored.
 */
export async function reorderTasks(householdId: string, input: ReorderTasksInput): Promise<void> {
  await prisma.$transaction(
    input.taskIds.map((id, position) =>
      prisma.task.updateMany({ where: { id, householdId }, data: { position } }),
    ),
  );
}

export async function createTask(
  householdId: string,
  userId: string,
  input: CreateTaskInput,
): Promise<TaskWithRelations> {
  const settings = await getPointsSettings(householdId);
  const state = stateFromInput(input, input.subtasks ?? [], settings.minutesPerPoint);
  const now = new Date();

  let ready: string | null = null;
  const created = await prisma.$transaction(async (tx) => {
    if (input.photoProof === true) await assertMayChangePhotoProof(tx, householdId, userId);
    await assertMemberRef(tx, householdId, input.assigneeId);
    await assertCategoryRef(tx, householdId, input.categoryId);
    const places = inputPlaces(input, []) ?? [];
    await assertPlaceRefs(tx, householdId, places);
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
        ...placeListColumns(places),
        assigneeId: rotation.assigneeId ?? null,
        rotationUserIds: rotation.rotationUserIds,
        createdById: userId,
        recurrenceId: rule?.id,
        // Off is stored as null, like the other switches.
        photoProof: input.photoProof === true ? true : null,
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

    ready = await announceTaskReady(tx, householdId, task, userId, settings.timezone);
    return task;
  });
  pushTaskReady(householdId, [ready]);
  return created;
}

/**
 * Auto-uncheck checklist items whose `resetIntervalDays` cadence has elapsed
 * since they were checked (e.g. "dishes" flips back daily inside a task that
 * repeats every 3 days). Runs opportunistically before tasks are read and from the
 * reminder cron, mirroring how reminders regenerate. The elapsed check is
 * `doneAt + N×24h <= now`, computed in JS because the cutoff varies per row.
 * Queued points survive this reset; `autoResetAt` lets the next check pay out.
 */
export async function resetDueSubtasks(householdId: string): Promise<number> {
  const candidates = await prisma.subtask.findMany({
    where: {
      done: true,
      resetIntervalDays: { not: null },
      // A task waiting for its check keeps its steps as they were sent.
      task: { householdId, status: { not: 'awaiting_review' } },
    },
    select: { id: true, doneAt: true, resetIntervalDays: true },
  });
  const now = Date.now();
  const due = candidates.filter(
    (s) =>
      // Items checked before doneAt existed reset immediately - better than
      // sticking checked forever.
      s.doneAt === null ||
      s.doneAt.getTime() + s.resetIntervalDays! * 86_400_000 <= now,
  );
  let count = 0;
  for (const s of due) {
    // Only if it's still the same check: someone may have unticked and
    // re-ticked it from the read (that fresh tick must survive, and its
    // paid-at-once award must not be detached).
    const res = await prisma.subtask.updateMany({
      where: { id: s.id, done: true, doneAt: s.doneAt },
      data: { ...UNCHECKED, autoResetAt: new Date(now) },
    });
    count += res.count;
  }
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
  // due date last. Priority: dueDate (asc, nulls last), then the newest first.
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
  const settings = await getPointsSettings(householdId);
  const now = new Date();

  let ready: string | null = null;
  const updated = await prisma.$transaction(async (tx) => {
    // Scope the update to the household so members can't touch other households.
    const found = await tx.task.findFirst({
      where: { id: input.taskId, householdId },
      include: { subtasks: { orderBy: { position: 'asc' } }, recurrence: true },
    });
    if (!found) throw new TaskNotFoundError(input.taskId);
    // Left waiting for a check with nothing to wait for: open again, so the
    // waiting rule below can't lock it for good.
    const existing = await healAwaitingReview(tx, householdId, found);
    if (input.photoProof !== undefined && input.photoProof !== (existing.photoProof === true)) {
      await assertMayChangePhotoProof(tx, householdId, userId);
    }
    // While it waits for an adult's OK, only what can't change the check may
    // change; the rest of the save goes on with what is left.
    const { taskId, recurrence, subtasks, rotationUserIds, roomId, floorId, roomIds, floorIds, ...rest } =
      existing.status === 'awaiting_review'
        ? await editWhileWaiting(tx, householdId, userId, existing, input, settings)
        : input;
    await assertMemberRef(tx, householdId, rest.assigneeId);
    await assertCategoryRef(tx, householdId, rest.categoryId);
    // New places when any place key is sent; a task whose place change
    // starts at the end of their order.
    const current = taskPlaceIds(existing);
    const nextPlaces = inputPlaces({ roomId, floorId, roomIds, floorIds }, current);
    if (nextPlaces) await assertPlaceRefs(tx, householdId, nextPlaces);
    const place = nextPlaces ? placeListColumns(nextPlaces) : undefined;
    const placeChanged = !!nextPlaces && !samePlaces(nextPlaces, current);

    // Completing pays points and reopening must take them back, so neither
    // can happen through an edit: Complete and Undo (task history) do that.
    const wasDone = existing.status === 'completed';
    if (rest.status === 'completed' && !wasDone) {
      throw new ConflictError('Use Complete to finish a task, so its points are paid.');
    }
    if (wasDone && (rest.status === 'pending' || rest.status === 'in_progress')) {
      throw new ConflictError('To reopen a completed task, undo its completion from the task’s history.');
    }

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
    // Archiving stops the cycle clock; un-archiving starts a fresh window.
    const archiving = rest.status === 'archived' && existing.status !== 'archived';
    const unarchiving = existing.status === 'archived' && rest.status !== undefined && rest.status !== 'archived';
    if (archiving) cycle = { cycleStartedAt: null, cycleEndsAt: null };
    else if (unarchiving) cycle = cycleWindow(rule, settings.timezone, now);

    // A task done for this cycle whose cycles were switched off would never
    // reopen (only a cycle start reopens it): move it on to its next
    // occurrence now, like completing a task without cycles does (opening
    // tomorrow at the earliest). A rule that has ended leaves it done.
    let reopen: { status: string; completedAt: null; dueDate: Date; opensAt: Date } | undefined;
    if (cycle && cycle.cycleEndsAt === null && !archiving && wasDone && existing.cycleEndsAt && rule) {
      const moved = completeOccurrence(normalizeRule(rule, settings.timezone), existing.dueDate, now, settings.timezone);
      if (moved.next) {
        reopen = { status: 'pending', completedAt: null, dueDate: moved.next, opensAt: moved.opensAt };
        await tx.subtask.updateMany({ where: { taskId }, data: UNCHECKED });
      }
    }

    // Restoring a task archived after it was done brings it back done: its
    // points were paid, and reopening it is Undo's job. A cycle task whose
    // fresh window starts after it was done is open again, as at a roll-over.
    let restore: { status: string; completedAt?: null } | undefined;
    if (unarchiving && existing.completedAt) {
      const newCycle = !!cycle?.cycleStartedAt && existing.completedAt < cycle.cycleStartedAt;
      restore = newCycle ? { status: 'pending', completedAt: null } : { status: 'completed' };
      if (newCycle) await tx.subtask.updateMany({ where: { taskId }, data: UNCHECKED });
    }

    // Points. A full checklist from the editor carries its own values;
    // otherwise a changed base is redistributed here (older clients).
    if (subtasks) {
      await replaceChecklist(tx, householdId, existing, subtasks, userId, now);
      const state = checklistState(existing, rest, subtasks, settings.minutesPerPoint);
      const ids = (
        await tx.subtask.findMany({ where: { taskId }, orderBy: { position: 'asc' }, select: { id: true } })
      ).map((s) => s.id);
      await writePoints(tx, taskId, ids, state);
    } else {
      const { state, changed } = baseEditState(existing, rest, settings.minutesPerPoint);
      if (changed) await writePoints(tx, taskId, existing.subtasks.map((s) => s.id), state);
    }

    // Rotation: saving a list puts the assignee on it (whose turn it is now).
    // Without one (older clients), a hand-picked assignee is taken as is -
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
        ...(place ?? {}),
        ...(placeChanged ? { position: null } : {}),
        ...assignment,
        recurrenceId,
        // A one-time task has no next occurrence to wait for.
        ...(recurrence === null ? { opensAt: null } : {}),
        ...(cycle ?? {}),
        ...(reopen ?? {}),
        ...(restore ?? {}),
        // Off is stored as null.
        ...(rest.photoProof !== undefined ? { photoProof: rest.photoProof ? true : null } : {}),
      },
      include: taskInclude,
    });

    // Drop the orphaned rule after detaching it from the task.
    if (recurrence === null && existing.recurrenceId) {
      await tx.recurrenceRule.delete({ where: { id: existing.recurrenceId } });
    }

    // "Your turn" notice: gone once the task can't be done; renewed when it
    // changes hands or comes back.
    if (task.status === 'completed' || task.status === 'archived') {
      await clearTaskReady(tx, householdId, task.id);
    } else if (task.assigneeId !== existing.assigneeId || unarchiving || reopen) {
      ready = await announceTaskReady(tx, householdId, task, userId, settings.timezone);
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
  pushTaskReady(householdId, [ready]);
  return updated;
}

/**
 * Make the checklist match the editor's list: items with a known id are
 * updated (done state is left alone - ticking goes through updateSubtask),
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

/** A supervised child or teen can't change whether a task asks for a photo (403); everyone else can. */
async function assertMayChangePhotoProof(tx: Tx, householdId: string, userId: string): Promise<void> {
  if (await isSupervisedChild(tx, householdId, userId)) {
    throw new ForbiddenError('Only an adult can change whether this task asks for a photo.', 'photoProof');
  }
}

type WaitingTask = TaskWithSteps & { recurrence: RuleRow | null };

/**
 * The edit rule while a task waits for its check (status awaiting_review).
 * Both editors send every field on every save, so values are compared, not
 * which fields are present: first every sent value equal to the stored one
 * (after the save path's own normalization) is dropped, before anything is
 * written, because even an identical recurrence would rewrite its derived
 * dates and restart the cycle check. Then only the title, notes, places and
 * new names for existing steps may remain, and not from the child who sent
 * it; anything else is refused with 409, and so is a step that is new,
 * missing or from another task. A step's `done` is never compared (a save
 * never changes it for an existing step). Renames are written here; the save
 * goes on with what is left.
 */
async function editWhileWaiting(
  tx: Tx,
  householdId: string,
  userId: string,
  existing: WaitingTask,
  input: UpdateTaskInput,
  settings: PointsSettings,
): Promise<UpdateTaskInput> {
  const check = await waitingCheck(tx, householdId, existing.id);
  const locked = () => checkConflict(WAITING_FOR_OK, 'check_waiting');
  const time = (d: Date | null | undefined) => d?.getTime() ?? null;

  // Values that may not change while it waits: refused unless sent as stored.
  if (input.type !== undefined && input.type !== existing.type) throw locked();
  if (input.priority !== undefined && input.priority !== existing.priority) throw locked();
  if (input.status !== undefined && input.status !== existing.status) throw locked();
  // To the minute: both editors send whole minutes, so a stored due date with
  // seconds still counts as sent unchanged (it then stays as stored).
  const minute = (d: Date | null | undefined) => (d ? Math.floor(d.getTime() / 60_000) : null);
  if (input.dueDate !== undefined && minute(input.dueDate) !== minute(existing.dueDate)) throw locked();
  if (input.categoryId !== undefined && (input.categoryId ?? null) !== existing.categoryId) throw locked();
  if (input.photoProof !== undefined && input.photoProof !== (existing.photoProof === true)) throw locked();
  if (input.rotationUserIds !== undefined) {
    const turn = await rotationColumns(tx, householdId, input.rotationUserIds, input.assigneeId, existing.assigneeId);
    const assignee = turn.assigneeId === undefined ? existing.assigneeId : turn.assigneeId ?? null;
    if (turn.rotationUserIds !== (existing.rotationUserIds ?? null) || assignee !== existing.assigneeId) throw locked();
  } else if (input.assigneeId !== undefined && (input.assigneeId ?? null) !== existing.assigneeId) {
    throw locked();
  }
  if (input.recurrence === null && existing.recurrence) throw locked();
  if (input.recurrence) {
    // The rule as saving would store it, apart from the dates it derives.
    // Its `timezone` is left out: nothing reads the stored zone (cycles, due
    // dates and next runs all use the household's), and both editors always
    // send 'UTC', so a task stored with another zone could never be re-saved
    // unchanged while it waits.
    const rule = existing.recurrence;
    const next = recurrenceData(input.recurrence, input.dueDate ?? existing.dueDate);
    const same =
      !!rule &&
      next.kind === rule.kind &&
      next.interval === rule.interval &&
      next.byWeekday === rule.byWeekday &&
      next.byMonthday === rule.byMonthday &&
      next.cron === rule.cron &&
      time(next.until) === time(rule.until) &&
      next.rollover === (rule.rollover ?? false) &&
      next.cycleWeekdays === rule.cycleWeekdays &&
      next.cycleMonthdays === rule.cycleMonthdays;
    if (!same) throw locked();
  }

  // Steps: the same ones, in the same order, with the same reset; only names may differ.
  const renames: { id: string; title: string }[] = [];
  if (input.subtasks) {
    const stored = existing.subtasks;
    if (
      input.subtasks.length !== stored.length ||
      input.subtasks.some((s, i) => !s.id || s.id !== stored[i].id)
    ) {
      throw locked();
    }
    for (const [i, s] of input.subtasks.entries()) {
      if ((s.resetIntervalDays ?? null) !== stored[i].resetIntervalDays) throw locked();
      if (s.title !== stored[i].title) renames.push({ id: stored[i].id, title: s.title });
    }
  }
  // Time and points: what the save would store, against what the task pays now.
  const current = effectivePoints(existing, settings.minutesPerPoint);
  const edited = input.subtasks
    ? checklistState(existing, input, input.subtasks, settings.minutesPerPoint)
    : baseEditState(existing, input, settings.minutesPerPoint).state;
  if (!samePoints(edited, current)) throw locked();

  // What may change: only what actually differs counts as a change.
  const kept: UpdateTaskInput = { taskId: existing.id };
  if (input.title !== undefined && input.title !== existing.title) kept.title = input.title;
  if (input.notes !== undefined && (input.notes ?? null) !== existing.notes) kept.notes = input.notes;
  const places = inputPlaces(input, taskPlaceIds(existing));
  const placesMoved = !!places && !samePlaces(places, taskPlaceIds(existing));
  if (placesMoved) {
    Object.assign(kept, {
      roomIds: input.roomIds,
      floorIds: input.floorIds,
      roomId: input.roomId,
      floorId: input.floorId,
    });
  }
  const changes = kept.title !== undefined || kept.notes !== undefined || placesMoved || renames.length > 0;
  // The child who sent it takes it back to change it.
  if (changes && check?.userId === userId) throw locked();
  for (const r of renames) {
    await tx.subtask.update({ where: { id: r.id }, data: { title: r.title } });
  }
  return kept;
}

/**
 * Complete a task and pay out its points (see pointsService). For recurring
 * tasks this records the completion, then:
 * - with cycles, the task is done for this cycle (status completed) and
 *   reopens at the next cycle start (rollTaskCycles);
 * - without, it rolls forward to its next occurrence (due date advances,
 *   status returns to pending) as before.
 * One-time tasks - and recurring tasks whose `until` end date has been
 * reached - are marked completed. The
 * completer checks steps left unchecked * (they "finish the rest").
 *
 * Guests hold `tasks:complete` but only for tasks assigned to them (see
 * src/lib/permissions.ts) - that narrower scope is enforced here.
 */
export async function completeTask(
  householdId: string,
  actor: CompletingActor,
  input: CompleteTaskInput,
): Promise<{ task: TaskWithRelations; completionId: string | null; submissionId?: string }> {
  await rollTaskCycles(householdId, new Date(), input.taskId);
  const settings = await getPointsSettings(householdId);
  // Only sent with a check (the schema refuses it otherwise). Rebuilt before
  // anything is written: a photo that can't be read is refused (422) as is.
  const photo = input.photo !== undefined ? readPhoto(input.photo) : null;
  // Supervisors of a checked child whose step points went for a check.
  const wake: string[] = [];
  // Whether the transaction that failed was sending the task for a check.
  let sending = false;
  const attempt = () => prisma.$transaction(async (tx): Promise<
    { completed: CompleteInTxResult } | { sent: { task: TaskWithRelations; submissionId: string; wake: string[] } }
  > => {
    wake.length = 0;
    sending = false;
    // Completed by hand: done now, and written now.
    const now = new Date();
    const opts: CompleteInTxOptions = { householdId, completer: actor, input, settings, at: now, now, wake };
    const existing = await loadForCompletion(tx, opts);
    // Who is checked is decided here, for every way of completing; the
    // compatibility fields say what this app can do about it.
    if (await needsCheck(tx, householdId, actor.id, existing)) {
      if (!input.checks) throw checkConflict('Update the Our Home app to send this for a check.', 'update_app');
      if (!input.forCheck) throw checkConflict('This task now needs a check.', 'check_needed');
      sending = true;
      return { sent: await sendForCheck(tx, existing, { householdId, child: actor, input, photo, now }) };
    }
    if (input.forCheck) {
      // Checks were turned off while the send dialog was open.
      throw checkConflict('This task doesn’t need a check any more. Tap Complete again.', 'check_not_needed');
    }
    return { completed: await writeCompletion(tx, existing, opts) };
  });
  const result = await attempt()
    .catch((err: unknown) => {
      // Two waiting checks clashed (TaskSubmission.waitingKey): a second
      // check of this task is refused; a child's steps check made by this
      // completion at the same moment as another is added to on a re-run.
      if (!isWaitingKeyClash(err)) throw err;
      if (sending) throw checkConflict(ALREADY_WAITING, 'check_already_waiting');
      return attempt();
    })
    .catch((err: unknown) => {
      // Two people completing at the same moment: Mongo aborts the second
      // transaction (write conflict). Only one is paid; tell the other plainly.
      if (isWriteConflict(err)) throw new ConflictError('Someone else just completed this task.');
      throw err;
    });
  if ('sent' in result) {
    wakeForChecks(householdId, result.sent.wake);
    return { task: result.sent.task, completionId: null, submissionId: result.sent.submissionId };
  }
  pushTaskReady(householdId, [result.completed.ready]);
  wakeForChecks(householdId, wake);
  return { task: result.completed.task, completionId: result.completed.completionId };
}

/** The photo sent with a check, rebuilt as a clean JPEG (security/jpeg.ts), or 422. */
function readPhoto(base64: string): RebuiltJpeg {
  const data = base64.replace(/^data:image\/jpeg;base64,/, '');
  return rebuildJpeg(new Uint8Array(Buffer.from(data, 'base64')));
}

/**
 * Sends [existing] for a check instead of completing it (Task Photo Proof):
 * the check remembers how the task stood (status, cycle, due date, the steps
 * ticked), keeps the photo, and the task waits (awaiting_review) with its
 * steps as they are. Each of the child's current supervisors gets a bell row.
 * Nothing is paid until one of them approves it.
 */
async function sendForCheck(
  tx: Tx,
  existing: CompletableTask,
  opts: { householdId: string; child: CompletingActor; input: CompleteTaskInput; photo: RebuiltJpeg | null; now: Date },
): Promise<{ task: TaskWithRelations; submissionId: string; wake: string[] }> {
  const { householdId, child, input, photo, now } = opts;
  const note = input.note?.trim() || null;
  // A task that asks for a photo takes one, or a note saying why not.
  if (existing.photoProof === true && !photo && !note) {
    throw new UnprocessableError('This task needs a photo. Can’t take a photo? Say why in the note.', 'photo');
  }
  // Checks the child started themselves: "task" sends and step re-ticks.
  if ((await startedWaiting(tx, householdId, child.id)) >= MAX_WAITING_CHECKS) {
    throw checkConflict(TOO_MANY_WAITING, 'check_cap');
  }

  const check = await tx.taskSubmission.create({
    data: {
      householdId,
      taskId: existing.id,
      userId: child.id,
      kind: 'task',
      note,
      submittedAt: now,
      prevStatus: existing.status,
      cycleStartedAt: existing.cycleStartedAt,
      cycleEndsAt: existing.cycleEndsAt,
      dueDate: existing.dueDate,
      stepIds: existing.subtasks.filter((s) => s.done).map((s) => s.id),
      // Frozen for settle: what the task asked when it was sent.
      photoProof: existing.photoProof === true,
      status: 'waiting',
      // A second check of this task written at the same moment clashes here (ALREADY_WAITING).
      waitingKey: waitingKey('task', existing.id, child.id),
    },
  });
  if (photo) {
    await tx.taskPhoto.create({
      data: {
        householdId,
        submissionId: check.id,
        userId: child.id,
        jpeg: new Uint8Array(photo.jpeg),
        width: photo.width,
        height: photo.height,
        bytes: photo.jpeg.length,
      },
    });
  }
  const task = await tx.task.update({
    where: { id: existing.id },
    data: { status: 'awaiting_review' },
    include: taskInclude,
  });
  // Nothing left for them to do while it waits: its "your turn" notice goes
  // (a take back or a send back puts it back, as an undo does).
  await clearTaskReady(tx, householdId, existing.id);

  const me = await tx.user.findFirst({ where: { id: child.id, householdId }, select: { name: true } });
  const supervisors = await currentSupervisors(tx, householdId, child.id);
  await askSupervisors(tx, householdId, check, me?.name ?? 'Someone', existing.title, supervisors);
  await logActivity(
    {
      householdId,
      actorId: child.id,
      verb: 'updated',
      subjectType: 'task',
      subjectId: existing.id,
      message: `sent “${existing.title}” for a check`,
    },
    tx,
  );
  return { task, submissionId: check.id, wake: supervisors };
}

/** What completing a task needs (completeInTx). */
export interface CompleteInTxOptions {
  householdId: string;
  /** Who completes it: paid for the steps nobody queued, and named in Activity. */
  completer: CompletingActor;
  input: CompleteTaskInput;
  settings: PointsSettings;
  /**
   * When the work counts as done: whether the task was open then, the
   * completion's completedAt, when steps nobody queued were earned, the
   * occurrence it moves on from, when the rest of the steps were finished,
   * and the task's completedAt. `now` when completed by hand; when it was
   * sent, for a check an adult approved later.
   */
  at: Date;
  /** When this is written: the points' awardedAt and the completion's recordedAt. */
  now: Date;
  /** The approved check (TaskSubmission) this completion pays, recorded on it. */
  submissionId?: string;
  /**
   * Collects whose phones to wake once the caller commits: the supervisors of
   * a checked child whose queued step points went to a "steps" check.
   */
  wake?: string[];
}

export interface CompleteInTxResult {
  task: TaskWithRelations;
  completionId: string;
  /** Who to tell the task is theirs now (pushTaskReady once committed), if anyone. */
  ready: string | null;
}

/**
 * Complete a task inside the caller's transaction (see completeTask). The
 * caller rolls the task's cycle over before its transaction (rollTaskCycles)
 * and pushes `ready` after it commits; neither happens here, so this can run
 * inside a transaction that does more (an adult approving a check).
 */
export async function completeInTx(tx: Tx, opts: CompleteInTxOptions): Promise<CompleteInTxResult> {
  const existing = await loadForCompletion(tx, opts);
  return writeCompletion(tx, existing, opts);
}

type CompletableTask = Prisma.TaskGetPayload<{ include: { recurrence: true; subtasks: true } }>;

/**
 * The task to complete, once it passes the checks every completion does: in
 * the household, a guest's own, not done, archived or waiting for an OK, and
 * open at `at`. Kept apart from writeCompletion so a caller can find out a
 * task may be completed before deciding what to write.
 */
async function loadForCompletion(
  tx: Tx,
  { householdId, completer, input, settings, at }: CompleteInTxOptions,
): Promise<CompletableTask> {
  const found = await tx.task.findFirst({
    where: { id: input.taskId, householdId },
    include: { recurrence: true, subtasks: { orderBy: { position: 'asc' } } },
  });
  if (!found) {
    throw new TaskNotFoundError(input.taskId);
  }
  // Waiting for an OK with nothing to wait for: opened again, so it can't block.
  const existing = await healAwaitingReview(tx, householdId, found);

  if (completer.role === 'guest' && existing.assigneeId !== completer.id) {
    throw new ForbiddenError(
      'Guests may only complete tasks assigned to them.',
    );
  }
  if (existing.status === 'completed' || existing.status === 'archived') {
    throw new ConflictError(
      existing.cycleEndsAt ? 'This task is already done for this cycle.' : 'This task is already completed.',
    );
  }
  // Sent for a check: its points are paid when an adult approves it (which
  // puts it back as it was before completing it), never by completing it again.
  if (existing.status === 'awaiting_review') {
    throw checkConflict('This is waiting for an adult’s OK.', 'check_waiting');
  }

  // A recurring task done for its occurrence waits for the next one to
  // open; completing it again would skip ahead and pay twice.
  if (existing.opensAt && existing.opensAt > at) {
    throw new ConflictError(`This task is already done. The next one opens ${opensLabel(existing.opensAt, settings.timezone)}.`);
  }
  return existing;
}

/** Records the completion of [existing] and pays its points (completeInTx). */
async function writeCompletion(
  tx: Tx,
  existing: CompletableTask,
  { householdId, completer, input, settings, at, now, submissionId, wake }: CompleteInTxOptions,
): Promise<CompleteInTxResult> {
  const userId = completer.id;
  let ready: string | null = null;
  const pending = await tx.pendingCredit.findMany({ where: { taskId: existing.id } });
  const pendingBy = new Map(pending.map((p) => [p.subtaskId, p]));
  // Checked children whose queued step points wait for an OK instead of
  // being paid now (completedByOutsider).
  const toCheck = await completedByOutsider(tx, householdId, existing, pending, userId);
  const diverted = new Set(pending.filter((p) => toCheck.has(p.userId)).map((p) => p.subtaskId));
  const state = effectivePoints(existing, settings.minutesPerPoint);
  const snapshot: CompletionSnapshot = {
    status: existing.status,
    completedAt: existing.completedAt?.toISOString() ?? null,
    dueDate: existing.dueDate?.toISOString() ?? null,
    nextRunAt: existing.recurrence?.nextRunAt?.toISOString() ?? null,
    cycleStartedAt: existing.cycleStartedAt?.toISOString() ?? null,
    cycleEndsAt: existing.cycleEndsAt?.toISOString() ?? null,
    opensAt: existing.opensAt?.toISOString() ?? null,
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
      completedAt: at,
      recordedAt: now,
      ...(submissionId ? { submissionId } : {}),
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
    // Steps nobody queued were earned when the work was done...
    now: at,
    // Diverted steps are left out entirely, never paid to the completer instead.
  }).filter((a) => !(a.subtaskId && diverted.has(a.subtaskId)));
  // ...and every point lands now.
  await writeAwards(tx, { householdId, taskId: existing.id, taskTitle: existing.title, completionId: completion.id, now }, awards);
  for (const childId of toCheck) {
    const entries = existing.subtasks.flatMap((s, i): StoredEntry[] => {
      const p = pendingBy.get(s.id);
      const pointsCenti = state.steps[i].pointsCenti;
      return p && p.userId === childId && pointsCenti > 0
        ? [{ subtaskId: s.id, title: s.title, pointsCenti, checkedAt: p.checkedAt.toISOString(), awardKind: 'step', completionId: completion.id }]
        : [];
    });
    if (entries.length === 0) continue;
    const supervisors = await addStepEntries(tx, {
      householdId,
      taskId: existing.id,
      taskTitle: existing.title,
      photoProof: existing.photoProof === true,
      childId,
      entries,
      now,
      startedByChild: false,
    });
    wake?.push(...supervisors);
  }
  await tx.pendingCredit.deleteMany({ where: { taskId: existing.id } });
  // Rows from before points get their values written now, so what was paid
  // matches what the task shows from here on.
  await writePoints(tx, existing.id, existing.subtasks.map((s) => s.id), state);

  // The next occurrence after the one being completed, and when it opens
  // (completeOccurrence): never the same day, so it can't be completed -
  // and paid - again straight away.
  const moveOn = existing.recurrence && !existing.cycleEndsAt
    ? completeOccurrence(normalizeRule(existing.recurrence, settings.timezone), existing.dueDate, at, settings.timezone)
    : null;
  const next = moveOn?.next ?? null;
  // A supported recurring rule that yields no next occurrence has reached its
  // `until` end date and should finalize. (cron yields null but isn't ended.)
  const recurrenceEnded =
    !!existing.recurrence && !existing.cycleEndsAt && existing.recurrence.kind !== 'cron' && next === null;
  const finishSteps = () =>
    tx.subtask.updateMany({
      where: { taskId: existing.id, done: false },
      data: { done: true, doneAt: at, doneById: userId, checkAwardId: null, autoResetAt: null },
    });

  let task: TaskWithRelations;
  if (existing.recurrence && existing.cycleEndsAt) {
    // Done for this cycle; rollTaskCycles reopens it at the next start.
    await finishSteps();
    task = await tx.task.update({
      where: { id: existing.id },
      data: { status: 'completed', completedAt: at },
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
        opensAt: moveOn!.opensAt,
        assigneeId: await rotatedAssignee(tx, householdId, existing, 1),
      },
      include: taskInclude,
    });
    // The next occurrence is open now: tell its assignee (not the completer).
    ready = await announceTaskReady(tx, householdId, task, userId, settings.timezone);
  } else {
    await finishSteps();
    task = await tx.task.update({
      where: { id: existing.id },
      data: { status: 'completed', completedAt: at },
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
  if (task.status === 'completed') await clearTaskReady(tx, householdId, task.id);

  return { task, completionId: completion.id, ready };
}

/**
 * The checked children (needsCheck) whose queued step points must wait for an
 * OK when [completerId] completes the task: anyone who isn't one of their
 * current supervisors (a sibling, the head). A completion by one of their
 * supervisors pays them as always, and the completer's own queued points
 * (an approved check paying the child who sent it) are never held back.
 */
async function completedByOutsider(
  tx: Tx,
  householdId: string,
  task: { photoProof?: boolean | null },
  pending: { userId: string }[],
  completerId: string,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const childId of new Set(pending.map((p) => p.userId))) {
    if (childId === completerId) continue;
    if (!(await needsCheck(tx, householdId, childId, task))) continue;
    if ((await currentSupervisors(tx, householdId, childId)).includes(completerId)) continue;
    out.add(childId);
  }
  return out;
}

/** Prisma's "transaction failed due to a writing conflict" (Mongo). */
export function isWriteConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

/**
 * Undo a completion: restore the task as it was just before and void the
 * points it paid. The completer can undo within UNDO_WINDOW_MS, the head any time
 * - but only for the task's latest completion, and only while nothing has
 * happened on the task since (otherwise the head voids point in the ledger).
 */
export async function undoCompletion(
  householdId: string,
  actor: CompletingActor,
  completionId: string,
): Promise<{ task: TaskWithRelations; outcome: UndoOutcome }> {
  const now = new Date();
  let ready: string | null = null;
  let outcome: UndoOutcome = 'undone';
  const wake: string[] = [];
  const result = await prisma.$transaction(async (tx) => {
    const completion = await tx.taskCompletion.findFirst({
      where: { id: completionId, task: { householdId } },
      include: { task: { include: { recurrence: true, subtasks: true } } },
    });
    if (!completion) throw new NotFoundError('Completion not found.');
    if (completion.undoneAt) throw new ConflictError('This completion was already undone.');
    if (completion.outcome === 'missed') throw new ConflictError('A missed cycle can’t be undone.');
    // A completion an approved check paid is the decider's to undo (or the
    // head's), never the child's: their own 10-minute window doesn't apply.
    const check = completion.submissionId
      ? await tx.taskSubmission.findFirst({ where: { id: completion.submissionId, householdId } })
      : null;
    if (completion.submissionId) {
      if (check?.status === 'auto_approved') {
        throw new ConflictError('This counted as done on its own, so it can’t be undone. Send it back instead.');
      }
      const supervising = !!check && (await supervisesNow(tx, householdId, actor.id, check.userId));
      if (!mayUndoCheck(check, actor, now, supervising, UNDO_WINDOW_MS)) {
        throw new ForbiddenError('Only the adult who approved this can undo it, within 10 minutes, or the head.');
      }
    } else if (!canUndo({ completedById: completion.userId, completedAt: completion.completedAt, actor, now })) {
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
    // Measured from when the completion was written, which is later than
    // completedAt for a check an adult approved after it was sent (the
    // same moment for one completed by hand).
    const written = completion.recordedAt ?? completion.completedAt;
    const at = written.getTime();
    const touched =
      task.subtasks.some((s) => (s.doneAt?.getTime() ?? 0) > at || (s.autoResetAt?.getTime() ?? 0) > at) ||
      (await tx.pendingCredit.count({ where: { taskId: task.id, checkedAt: { gt: written } } })) > 0;
    const snapshot = JSON.parse(completion.snapshot) as CompletionSnapshot;
    const rolled = (task.cycleStartedAt?.toISOString() ?? null) !== snapshot.cycleStartedAt;
    // Saved in the editor since (completing itself writes the row at the
    // same moment, hence the margin): undoing would silently put back the old
    // due date / recurrence / assignee over that edit.
    const edited = task.updatedAt.getTime() > written.getTime() + EDIT_MARGIN_MS;
    if (later > 0 || touched || rolled || edited) {
      throw new ConflictError('The task has changed since it was completed; ask the head to void the points instead.');
    }

    // Step points this completion sent for a check (a checked child's, when
    // whoever completed it doesn't look after them; see completedByOutsider).
    // Still waiting: taken out of the check, as undoing queues them again.
    // Sent back by an adult: that stands, so the step is left unticked with
    // no queued points, to be done again (and paid to whoever does it).
    const sentBack = new Set<string>();
    if (snapshot.pending.some((p) => p.userId !== completion.userId)) {
      const checks = await tx.taskSubmission.findMany({
        where: {
          householdId,
          taskId: task.id,
          kind: 'steps',
          status: { in: ['waiting', 'sent_back'] },
          entries: { contains: `"completionId":"${completion.id}"` },
        },
      });
      const fromThis = (e: StoredEntry) => e.completionId === completion.id;
      for (const c of checks) {
        if (c.status === 'sent_back') {
          for (const e of parseEntries(c.entries).filter(fromThis)) sentBack.add(e.subtaskId);
        } else if (await dropStepEntries(tx, householdId, c, fromThis, now)) {
          wake.push(...(await currentSupervisors(tx, householdId, c.userId)));
        }
      }
    }

    const date = (v: string | null) => (v ? new Date(v) : null);
    for (const s of snapshot.steps) {
      if (!task.subtasks.some((t) => t.id === s.id)) continue;
      await tx.subtask.update({
        where: { id: s.id },
        data: sentBack.has(s.id)
          ? UNCHECKED
          : {
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
    const restore = snapshot.pending.filter((p) => liveSteps.has(p.subtaskId) && !sentBack.has(p.subtaskId));
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
    // An approved check whose child still needs one goes back to To check,
    // waiting again, instead of back to how the task stood.
    const backToCheck = !!check && (await needsCheck(tx, householdId, check.userId, task));
    const restored = await tx.task.update({
      where: { id: task.id },
      data: {
        status: backToCheck ? 'awaiting_review' : snapshot.status,
        completedAt: date(snapshot.completedAt),
        dueDate: date(snapshot.dueDate),
        // Open again, as it was (absent in older snapshots, from before the lock).
        opensAt: date(snapshot.opensAt ?? null),
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
    if (backToCheck && check) {
      // Waiting again, as if never decided: its supervisors' rows come back,
      // the child's answer goes, and nobody is told it's their turn.
      await tx.taskSubmission.update({
        where: { id: check.id },
        data: {
          status: 'waiting',
          decidedById: null,
          decidedAt: null,
          completionId: null,
          photoDeleteAt: null,
          waitingKey: waitingKey(check.kind, check.taskId, check.userId),
        },
      });
      const child = await tx.user.findFirst({ where: { id: check.userId, householdId }, select: { name: true } });
      const supervisors = await currentSupervisors(tx, householdId, check.userId);
      await askSupervisors(tx, householdId, check, child?.name ?? 'Someone', task.title, supervisors);
      await clearChildBell(tx, householdId, check.id);
      await clearTaskReady(tx, householdId, restored.id);
      wake.push(check.userId, ...supervisors);
      outcome = 'back_to_check';
    } else if (restored.status === 'completed' || restored.status === 'archived') {
      // Back as it was: its assignee's notice comes back with it (and the one
      // the completion gave the next person in a rotation goes).
      await clearTaskReady(tx, householdId, restored.id);
    } else {
      ready = await announceTaskReady(tx, householdId, restored, actor.id);
    }
    if (check && !backToCheck) {
      // The child's "Approved" row no longer holds.
      await clearChildBell(tx, householdId, check.id);
      wake.push(check.userId);
    }
    return restored;
  });
  pushTaskReady(householdId, [ready]);
  wakeForChecks(householdId, wake);
  return { task: result, outcome };
}

/**
 * What an undo did, so the client says the right thing: "back_to_check"
 * ("Back in To check": the child still needs a check, so it waits again) or
 * "undone" ("Undone. The points were taken back.").
 */
export type UndoOutcome = 'back_to_check' | 'undone';

/** After completion, how long it may still write the task row. */
const EDIT_MARGIN_MS = 10_000;

/** When a done task opens again, e.g. "Thu, Oct 22", in the household's zone. */
function opensLabel(opensAt: Date, timeZone: string): string {
  return opensAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone });
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
  // One an approved check paid follows undoCompletion's rule for checks, so
  // no Undo is shown that the server would refuse.
  const checkIds = latestLive?.submissionId ? [latestLive.submissionId] : [];
  const checks = checkIds.length
    ? await prisma.taskSubmission.findMany({ where: { householdId, id: { in: checkIds } } })
    : [];
  const supervising = checks.length ? await supervisedNow(prisma, householdId, actor.id) : new Set<string>();
  const undoable = (c: (typeof rows)[number]) => {
    if (!c.submissionId) return canUndo({ completedById: c.userId, completedAt: c.completedAt, actor, now });
    const check = checks.find((s) => s.id === c.submissionId);
    return mayUndoCheck(check, actor, now, !!check && supervising.has(check.userId), UNDO_WINDOW_MS);
  };
  return rows.map((c) => ({
    id: c.id,
    note: c.note,
    completedAt: c.completedAt.toISOString(),
    user: c.user ? { id: c.user.id, name: c.user.name } : null,
    outcome: c.outcome ?? 'completed',
    undoneAt: c.undoneAt?.toISOString() ?? null,
    points: (paid.get(c.id) ?? 0) / 100,
    canUndo: c === latestLive && !!c.snapshot && undoable(c),
  }));
}

/**
 * Permanently delete a task. Completions and subtasks cascade via their DB
 * relation, but the recurrence rule is the FK parent (Task.recurrenceId ->
 * SetNull on delete), so it is removed explicitly to avoid orphaning it. Queued
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
    await clearTaskReady(tx, householdId, existing.id);
    // Its checks and photos go with it (cascade); so do their bell rows.
    await tx.notification.deleteMany({
      where: { householdId, subjectId: existing.id, type: { in: [TASK_REVIEW_TYPE, TASK_REVIEWED_TYPE] } },
    });
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
    const task = await healAwaitingReview(
      tx,
      householdId,
      await tx.task.findFirstOrThrow({
        where: { id: input.taskId },
        include: { subtasks: { orderBy: { position: 'asc' } } },
      }),
    );
    // A new step would change what the adult is checking.
    if (task.status === 'awaiting_review') throw checkConflict(WAITING_FOR_OK, 'check_waiting');
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
 * Edit a step's title/order/reset, or check/uncheck it - which is where step
 * points are queued or paid (checkOutcome) and dropped, on a hand, unchecked.
 */
export async function updateSubtask(
  householdId: string,
  input: UpdateSubtaskInput,
  actor?: CompletingActor,
  /**
   * allowCheck: the caller's per-user limit, asked only when a tick puts
   * step points in a check (false: 429). Ordinary ticks never ask it.
   */
  opts: { allowCheck?: () => boolean } = {},
): Promise<TaskWithRelations> {
  const taskId = await assertSubtaskInHousehold(input.subtaskId, householdId);
  // Guests may toggle items only on tasks assigned to them - the same scope
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
    await setStepDone(householdId, taskId, input.subtaskId, input.done, actor ?? null, opts.allowCheck);
  }
  if (input.title !== undefined || input.resetIntervalDays !== undefined || input.position !== undefined) {
    // The waiting rule is read and checked in the transaction that writes.
    // (A tick sent with it is refused on a waiting task anyway, with the same 409.)
    await prisma.$transaction(async (tx) => {
      await assertStepEditWhileWaiting(tx, householdId, taskId, input, actor);
      if (input.title !== undefined || input.resetIntervalDays !== undefined) {
        await tx.subtask.update({
          where: { id: input.subtaskId },
          data: { title: input.title, resetIntervalDays: input.resetIntervalDays },
        });
      }
      if (input.position !== undefined) {
        // Move it and renumber the rest, so no two steps share a position.
        const ids = (
          await tx.subtask.findMany({ where: { taskId }, orderBy: { position: 'asc' }, select: { id: true } })
        ).map((s) => s.id).filter((id) => id !== input.subtaskId);
        ids.splice(Math.min(input.position, ids.length), 0, input.subtaskId);
        for (const [position, id] of ids.entries()) {
          await tx.subtask.update({ where: { id }, data: { position } });
        }
      }
    });
  }
  return getTaskOrThrow(householdId, taskId);
}

/**
 * The waiting rule (editWhileWaiting) for one step edited on its own: while
 * the task waits for its check, a new name is fine (not from the child who
 * sent it); a new reset or a move is refused. Sent unchanged is fine. Read
 * in [tx], the transaction that then writes the edit.
 */
async function assertStepEditWhileWaiting(
  tx: Tx,
  householdId: string,
  taskId: string,
  input: UpdateSubtaskInput,
  actor: CompletingActor | undefined,
): Promise<void> {
  const task = await healAwaitingReview(
    tx,
    householdId,
    await tx.task.findFirstOrThrow({
      where: { id: taskId, householdId },
      include: { subtasks: { orderBy: { position: 'asc' } } },
    }),
  );
  if (task.status !== 'awaiting_review') return;
  const index = task.subtasks.findIndex((s) => s.id === input.subtaskId);
  const step = task.subtasks[index];
  if (input.resetIntervalDays !== undefined && (input.resetIntervalDays ?? null) !== step.resetIntervalDays) {
    throw checkConflict(WAITING_FOR_OK, 'check_waiting');
  }
  if (input.position !== undefined && Math.min(input.position, task.subtasks.length - 1) !== index) {
    throw checkConflict(WAITING_FOR_OK, 'check_waiting');
  }
  if (input.title !== undefined && input.title !== step.title) {
    const check = await waitingCheck(tx, householdId, taskId);
    if (check && actor && check.userId === actor.id) throw checkConflict(WAITING_FOR_OK, 'check_waiting');
  }
}

async function setStepDone(
  householdId: string,
  taskId: string,
  subtaskId: string,
  done: boolean,
  actor: CompletingActor | null,
  allowCheck?: () => boolean,
) {
  const settings = await getPointsSettings(householdId);
  const now = new Date();
  // Supervisors whose bell rows for a "steps" check changed, woken after commit.
  const wake: string[] = [];
  // One tick asks the per-user limit once, even when it runs again below.
  let allowed: boolean | undefined;
  const allowOnce = allowCheck && (() => (allowed ??= allowCheck()));
  // Run again once when it lost the race to start the child's steps check:
  // the re-run finds that check and adds to it.
  await retryOnWaitingClash(() => prisma.$transaction(async (tx) => {
    wake.length = 0;
    // Left waiting for a check with nothing to wait for: open again first.
    const task = await healAwaitingReview(
      tx,
      householdId,
      await tx.task.findFirstOrThrow({
        where: { id: taskId },
        include: { subtasks: { orderBy: { position: 'asc' } } },
      }),
    );
    if (task.status === 'archived') {
      throw new ConflictError('This task is archived; restore it before ticking steps.');
    }
    // Its steps stay as they were sent, so the adult checks what was done.
    if (task.status === 'awaiting_review') throw checkConflict(WAITING_FOR_OK, 'check_waiting');
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
        if (points > 0 && (await needsCheck(tx, householdId, actor!.id, task))) {
          // A checked child: the repeat's points wait for an adult's OK in
          // their "steps" check instead. Still one tap: no photo, no note.
          const supervisors = await addStepEntries(tx, {
            householdId,
            taskId,
            taskTitle: task.title,
            photoProof: task.photoProof === true,
            childId: actor!.id,
            entries: [{ subtaskId, title: step.title, pointsCenti: points, checkedAt: now.toISOString(), awardKind: 'step_repeat' }],
            now,
            startedByChild: true,
            allow: allowOnce,
          });
          wake.push(...supervisors);
        } else if (points > 0) {
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
    // Set when the points this check paid are taken back: the step is then
    // as it was after its own reset, so re-ticking it pays again (once).
    let autoResetAt: Date | null = null;
    // This very tick waiting for an OK in its child's "steps" check (an entry
    // for an earlier tick of the step is a different one, and stays).
    const tickAt = step.doneAt?.toISOString();
    const isThisTick = (e: StoredEntry) => e.awardKind === 'step_repeat' && e.subtaskId === subtaskId && e.checkedAt === tickAt;
    const open = !step.checkAwardId && step.doneById && tickAt ? await waitingSteps(tx, householdId, taskId, step.doneById) : null;
    const tickCheck = open && parseEntries(open.entries).some(isThisTick) ? open : null;
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
        autoResetAt = now;
      }
    } else if (tickCheck) {
      // Ticked again and waiting for an OK: as with a repeat paid at once
      // (above), the child, an adult who looks after them, or the head takes
      // it out of the check and re-ticking it counts again; anyone else's
      // uncheck leaves it waiting. Its queued points stay either way.
      const child = tickCheck.userId;
      if (
        actor &&
        (actor.id === child || actor.role === 'head' || (await supervisesNow(tx, householdId, actor.id, child)))
      ) {
        await dropStepEntries(tx, householdId, tickCheck, isThisTick, now);
        wake.push(...(await currentSupervisors(tx, householdId, child)));
        autoResetAt = now;
      }
    } else if (pending) {
      // Unchecked by hand: its queued points are dropped.
      await tx.pendingCredit.delete({ where: { id: pending.id } });
    }
    await tx.subtask.update({ where: { id: subtaskId }, data: { ...UNCHECKED, autoResetAt } });
  }));
  wakeForChecks(householdId, wake);
}

/**
 * Persist a full checklist order: each subtask's position becomes its index in
 * `subtaskIds`. The id set must exactly match the task's current checklist, so a
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
      orderBy: { position: 'asc' },
    });
    const existingIds = new Set(existing.map((s) => s.id));
    const sameSet =
      existing.length === input.subtaskIds.length &&
      input.subtaskIds.every((id) => existingIds.has(id));
    if (!sameSet) {
      throw new SubtaskOrderConflictError(input.taskId);
    }
    // While it waits for its check the order stays; the same order is fine.
    const moved = input.subtaskIds.some((id, i) => id !== existing[i].id);
    if (moved) {
      const row = await tx.task.findFirst({ where: { id: input.taskId, householdId }, select: { id: true, status: true } });
      if (row && (await healAwaitingReview(tx, householdId, row)).status === 'awaiting_review') {
        throw checkConflict(WAITING_FOR_OK, 'check_waiting');
      }
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
    const task = await healAwaitingReview(
      tx,
      householdId,
      await tx.task.findFirstOrThrow({
        where: { id: taskId },
        include: { subtasks: { orderBy: { position: 'asc' } } },
      }),
    );
    // Removing a step would change what the adult is checking.
    if (task.status === 'awaiting_review') throw checkConflict(WAITING_FOR_OK, 'check_waiting');
    const index = task.subtasks.findIndex((s) => s.id === subtaskId);
    const state = removeStep(effectivePoints(task, settings.minutesPerPoint), index);
    await tx.pendingCredit.deleteMany({ where: { subtaskId } });
    await tx.subtask.delete({ where: { id: subtaskId } });
    await writePoints(tx, taskId, task.subtasks.filter((s) => s.id !== subtaskId).map((s) => s.id), state);
  });
  return getTaskOrThrow(householdId, taskId);
}

export async function getTaskOrThrow(
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
      `The checklist for task ${taskId} changed while reordering - refresh and try again.`,
    );
    this.name = 'SubtaskOrderConflictError';
  }
}
