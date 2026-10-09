import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { DEFAULT_MINUTES_PER_POINT, withDefaults } from '@/lib/taskPoints';
import {
  DEFAULT_TIMEZONE,
  elapsedDays,
  isValidTimeZone,
  localDateOf,
  periodBounds,
  startOfLocalDate,
  type LocalDate,
  type Period,
} from '@/lib/taskCycles';
import type { PointAwardDTO, PointsSettingsDTO, PointsSummaryDTO } from '@/lib/types';
import { ForbiddenError, NotFoundError } from '@/server/services/errors';

// Task points: who earns what, when, and the ledger behind the stats. The
// rules (docs/points.md):
// - A step's first check in a cycle queues its points for whoever checked it
//   (PendingCredit). Nothing pays until the task is completed.
// - Completing pays every step once: to whoever queued it, otherwise to the
//   completer (who "finishes the rest"). A task without steps pays its points
//   to the completer.
// - Re-checking a step after its own auto-reset pays that step at once
//   ("step_repeat"), and so does checking a step on an already-finished task.
// - Unchecking by hand drops the step's queued points; a cycle that runs out
//   unfinished drops all of them.
// - The completer can undo for UNDO_WINDOW_MS; after that only the head.
//   Awards are voided, never deleted.

export const UNDO_WINDOW_MS = 10 * 60 * 1000;

type Db = Prisma.TransactionClient | typeof prisma;

export interface PointsSettings {
  timezone: string;
  weekStartsOn: number;
  minutesPerPoint: number;
}

/** A household row's settings with the defaults filled in. */
export function settingsFrom(row: {
  timezone?: string | null;
  weekStartsOn?: number | null;
  minutesPerPoint?: number | null;
} | null): PointsSettings {
  const tz = row?.timezone && isValidTimeZone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE;
  return {
    timezone: tz,
    weekStartsOn: row?.weekStartsOn ?? 0,
    minutesPerPoint: row?.minutesPerPoint && row.minutesPerPoint > 0 ? row.minutesPerPoint : DEFAULT_MINUTES_PER_POINT,
  };
}

export async function getPointsSettings(householdId: string, db: Db = prisma): Promise<PointsSettings> {
  const row = await db.household.findUnique({
    where: { id: householdId },
    select: { timezone: true, weekStartsOn: true, minutesPerPoint: true },
  });
  return settingsFrom(row);
}

export async function updatePointsSettings(
  householdId: string,
  input: Partial<PointsSettingsDTO>,
): Promise<PointsSettings> {
  const row = await prisma.household.update({
    where: { id: householdId },
    data: {
      timezone: input.timezone,
      weekStartsOn: input.weekStartsOn,
      minutesPerPoint: input.minutesPerPoint,
    },
    select: { timezone: true, weekStartsOn: true, minutesPerPoint: true },
  });
  return settingsFrom(row);
}

// --- Effective values -------------------------------------------------------

interface TaskPointsRow {
  estimatedMinutes: number | null;
  baseMinutes: number | null;
  basePointsCenti: number | null;
  pointsFollowTime: boolean | null;
  subtasks: {
    minutes: number | null;
    pointsCenti: number | null;
    minutesCustom: boolean | null;
    pointsFollowTime: boolean | null;
  }[];
}

/** The task's points state with rows from before points filled in. */
export function effectivePoints<T extends TaskPointsRow>(task: T, minutesPerPoint: number) {
  return withDefaults(
    {
      baseMinutes: task.baseMinutes,
      basePointsCenti: task.basePointsCenti,
      pointsFollowTime: task.pointsFollowTime ?? true,
      legacyMinutes: task.estimatedMinutes,
    },
    task.subtasks.map((s) => ({
      minutes: s.minutes ?? undefined,
      pointsCenti: s.pointsCenti ?? undefined,
      minutesCustom: s.minutesCustom ?? false,
      pointsFollowTime: s.pointsFollowTime ?? true,
    })),
    minutesPerPoint,
  );
}

// --- Payout -----------------------------------------------------------------

export interface PayoutStep {
  id: string;
  title: string;
  pointsCenti: number;
  /** Who queued it this cycle, and when (null = nobody). */
  pending: { userId: string; checkedAt: Date } | null;
}

export interface PlannedAward {
  userId: string;
  subtaskId: string | null;
  kind: 'task' | 'step';
  pointsCenti: number;
  stepTitle: string | null;
  earnedAt: Date;
}

/**
 * Who gets what when a task is completed. Every step pays exactly once — to
 * its queued checker, else to the completer — so the awards add up to the
 * task's live points. Zero-point rows are skipped.
 */
export function planPayout(input: {
  taskPointsCenti: number;
  steps: PayoutStep[];
  completerId: string;
  now: Date;
}): PlannedAward[] {
  const { steps, completerId, now } = input;
  if (steps.length === 0) {
    return input.taskPointsCenti > 0
      ? [{ userId: completerId, subtaskId: null, kind: 'task', pointsCenti: input.taskPointsCenti, stepTitle: null, earnedAt: now }]
      : [];
  }
  return steps
    .filter((s) => s.pointsCenti > 0)
    .map((s) => ({
      userId: s.pending?.userId ?? completerId,
      subtaskId: s.id,
      kind: 'step' as const,
      pointsCenti: s.pointsCenti,
      stepTitle: s.title,
      earnedAt: s.pending?.checkedAt ?? now,
    }));
}

/** What checking a step does to points. */
export type CheckOutcome = 'queue' | 'pay_now' | 'nothing';

/**
 * - Already checked → nothing.
 * - Re-checked after the step's own auto-reset, and its points were already
 *   queued this cycle or the task is finished (completed / done this cycle)
 *   → pay now: a repeat earns only its own points.
 * - Queued already or task finished, but unchecked *by hand* since → nothing
 *   (unchecking and re-checking never earns twice).
 * - Otherwise → queue until the task is completed.
 */
export function checkOutcome(input: {
  alreadyDone: boolean;
  taskFinished: boolean;
  hasPending: boolean;
  autoReset: boolean;
}): CheckOutcome {
  if (input.alreadyDone) return 'nothing';
  if (input.hasPending || input.taskFinished) return input.autoReset ? 'pay_now' : 'nothing';
  return 'queue';
}

/** May `actor` undo/void this completion's points now? The completer within
 *  the window; the head any time. */
export function canUndo(input: {
  completedById: string | null;
  completedAt: Date;
  actor: { id: string; role: string };
  now: Date;
}): boolean {
  if (input.actor.role === 'head') return true;
  return (
    input.completedById === input.actor.id &&
    input.now.getTime() - input.completedAt.getTime() <= UNDO_WINDOW_MS
  );
}

/** The task as it was just before a completion, for undo. */
export interface CompletionSnapshot {
  status: string;
  completedAt: string | null;
  dueDate: string | null;
  nextRunAt: string | null;
  cycleStartedAt: string | null;
  cycleEndsAt: string | null;
  steps: {
    id: string;
    done: boolean;
    doneAt: string | null;
    doneById: string | null;
    checkAwardId: string | null;
    autoResetAt: string | null;
  }[];
  pending: { subtaskId: string; userId: string; checkedAt: string; cycleStartedAt: string | null }[];
}

export async function writeAwards(
  db: Db,
  base: { householdId: string; taskId: string; taskTitle: string; completionId: string | null; now: Date },
  awards: PlannedAward[],
): Promise<void> {
  if (awards.length === 0) return;
  await db.pointAward.createMany({
    data: awards.map((a) => ({
      householdId: base.householdId,
      userId: a.userId,
      taskId: base.taskId,
      subtaskId: a.subtaskId,
      completionId: base.completionId,
      kind: a.kind,
      pointsCenti: a.pointsCenti,
      taskTitle: base.taskTitle,
      stepTitle: a.stepTitle,
      earnedAt: a.earnedAt,
      awardedAt: base.now,
    })),
  });
}

/** Void one award (head only), keeping it in the ledger. */
export async function voidAward(
  householdId: string,
  actor: { id: string; role: string },
  input: { awardId: string; reason: string },
): Promise<PointAwardDTO> {
  if (actor.role !== 'head') throw new ForbiddenError('Only the head can void points.');
  const award = await prisma.pointAward.findFirst({ where: { id: input.awardId, householdId } });
  if (!award) throw new NotFoundError('Points entry not found.');
  if (award.voidedAt) return awardToDTO(award, new Map());
  const updated = await prisma.pointAward.update({
    where: { id: award.id },
    data: { voidedAt: new Date(), voidedById: actor.id, voidReason: input.reason },
  });
  return awardToDTO(updated, new Map());
}

// --- Reporting --------------------------------------------------------------

type AwardRow = Prisma.PointAwardGetPayload<object>;

export function awardToDTO(a: AwardRow, names: Map<string, string>): PointAwardDTO {
  return {
    id: a.id,
    userId: a.userId,
    userName: names.get(a.userId) ?? null,
    taskId: a.taskId,
    subtaskId: a.subtaskId,
    kind: a.kind,
    points: a.pointsCenti / 100,
    taskTitle: a.taskTitle,
    stepTitle: a.stepTitle,
    earnedAt: a.earnedAt.toISOString(),
    awardedAt: a.awardedAt.toISOString(),
    voided: a.voidedAt != null,
    voidReason: a.voidReason,
  };
}

const NOT_VOIDED = { OR: [{ voidedAt: null }, { voidedAt: { isSet: false } }] } satisfies Prisma.PointAwardWhereInput;

/** Queued (not yet paid) points per user, from their pending credits. */
async function pendingByUser(householdId: string, minutesPerPoint: number): Promise<Map<string, number>> {
  const credits = await prisma.pendingCredit.findMany({ where: { householdId } });
  const out = new Map<string, number>();
  if (credits.length === 0) return out;
  const tasks = await prisma.task.findMany({
    where: { id: { in: [...new Set(credits.map((c) => c.taskId))] }, householdId },
    include: { subtasks: { orderBy: { position: 'asc' } } },
  });
  const stepPoints = new Map<string, number>();
  for (const t of tasks) {
    const state = effectivePoints(t, minutesPerPoint);
    t.subtasks.forEach((s, i) => stepPoints.set(s.id, state.steps[i].pointsCenti));
  }
  for (const c of credits) {
    out.set(c.userId, (out.get(c.userId) ?? 0) + (stepPoints.get(c.subtaskId) ?? 0));
  }
  return out;
}

/**
 * Totals per member for the period containing `date` (local, household time
 * zone; default today): points, points per day (over the days elapsed so
 * far), award count and queued points, plus household averages per person.
 */
export async function pointsSummary(
  householdId: string,
  period: Period,
  date?: LocalDate,
  now = new Date(),
): Promise<PointsSummaryDTO> {
  const settings = await getPointsSettings(householdId);
  const anchor = date ? new Date(startOfLocalDate(date, settings.timezone).getTime() + 12 * 3_600_000) : now;
  const bounds = periodBounds(period, anchor, settings.timezone, settings.weekStartsOn);
  const days = bounds.start > now ? bounds.days : elapsedDays(bounds, now, settings.timezone);

  const [members, grouped, pending] = await Promise.all([
    prisma.user.findMany({ where: { householdId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.pointAward.groupBy({
      by: ['userId'],
      where: { householdId, awardedAt: { gte: bounds.start, lt: bounds.end }, ...NOT_VOIDED },
      _sum: { pointsCenti: true },
      _count: { _all: true },
    }),
    pendingByUser(householdId, settings.minutesPerPoint),
  ]);
  const byUser = new Map(grouped.map((g) => [g.userId, g]));
  const rows = members.map((m) => {
    const centi = byUser.get(m.id)?._sum.pointsCenti ?? 0;
    return {
      userId: m.id,
      name: m.name,
      points: centi / 100,
      perDay: round2(centi / 100 / days),
      awards: byUser.get(m.id)?._count._all ?? 0,
      queued: (pending.get(m.id) ?? 0) / 100,
    };
  });
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  const total = rows.reduce((a, r) => a + r.points, 0);
  const people = Math.max(1, rows.length);
  return {
    period,
    start: bounds.start.toISOString(),
    end: bounds.end.toISOString(),
    startDate: formatLocalDate(bounds.startDate),
    days: bounds.days,
    elapsedDays: days,
    timezone: settings.timezone,
    members: rows,
    householdTotal: round2(total),
    averagePerPerson: round2(total / people),
    averagePerPersonPerDay: round2(total / people / days),
  };
}

/** The ledger, newest first, optionally for one member and/or a period. */
export async function listAwards(
  householdId: string,
  query: { userId?: string; period?: Period; date?: LocalDate; limit?: number },
): Promise<PointAwardDTO[]> {
  let range: Prisma.PointAwardWhereInput = {};
  if (query.period) {
    const settings = await getPointsSettings(householdId);
    const anchor = query.date
      ? new Date(startOfLocalDate(query.date, settings.timezone).getTime() + 12 * 3_600_000)
      : new Date();
    const bounds = periodBounds(query.period, anchor, settings.timezone, settings.weekStartsOn);
    range = { awardedAt: { gte: bounds.start, lt: bounds.end } };
  }
  const [rows, members] = await Promise.all([
    prisma.pointAward.findMany({
      where: { householdId, userId: query.userId, ...range },
      orderBy: [{ awardedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(500, query.limit ?? 200),
    }),
    prisma.user.findMany({ where: { householdId }, select: { id: true, name: true } }),
  ]);
  const names = new Map(members.map((m) => [m.id, m.name]));
  return rows.map((r) => awardToDTO(r, names));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatLocalDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

/** Today's date in the household's zone, as "YYYY-MM-DD". */
export function todayIn(settings: PointsSettings, now = new Date()): string {
  return formatLocalDate(localDateOf(now, settings.timezone));
}
