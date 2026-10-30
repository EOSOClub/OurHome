import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '@/server/services/errors';
import { NOT_VOIDED, effectivePoints, getPointsSettings } from '@/server/services/pointsService';
import { pushTaskReady } from '@/server/services/taskReadyService';
import {
  UNCHECKED,
  isWriteConflict,
  payCheckInTx,
  rollTaskCycles,
} from '@/server/services/taskService';
import {
  ALREADY_DECIDED,
  CYCLE_END_REVIEW_MS,
  PHOTO_KEEP_MS,
  clearReviewBells,
  currentSupervisors,
  healAwaitingReview,
  needsCheck,
  statusBefore,
  supervisedNow,
  supervisesNow,
  tellChild,
  wakeForChecks,
  withdrawInTx,
} from '@/server/services/taskReviewService';
import { canBeSupervised } from '@/lib/permissions';
import { formatPoints, liveTotals } from '@/lib/taskPoints';
import type { TaskSubmissionAction, TaskSubmissionDTO, TaskSubmissionEntryDTO } from '@/lib/types';
import type { DecideSubmissionInput } from '@/lib/validation/task';

// Task Photo Proof, after a check is sent (taskService.completeTask sends it):
// the adults who look after the child decide it (approve, or send it back),
// the child can take it back while it waits, and checks nobody can decide
// any more are settled (settleOrphanedSubmissions). Also the To check list,
// the photo, and the dashboard's count. Only the child's current supervisors
// decide, checked at the moment they act; the head is not one unless the
// Members page says so.

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: string };

/** What a cycle-end item's take-back says when its 3 days are over. */
const TOO_LATE = 'Points can only be taken back for 3 days after the day ended.';

/** Each decision, withdraw and take-back reports a lost race the same plain way. */
function plainConflict(err: unknown): never {
  if (isWriteConflict(err)) throw new ConflictError(ALREADY_DECIDED);
  throw err;
}

/** Unset or null: Mongo stores a never-written optional field as missing. */
function unset(field: 'decidedById' | 'takenBackAt') {
  return { OR: [{ [field]: null }, { [field]: { isSet: false } }] };
}

/**
 * The checks that belong in To check right now: waiting ones, and ones
 * counted as done when their day ended, for 3 days, until an adult approves
 * them or takes their points back.
 */
function toCheckWhere(now: Date) {
  return {
    OR: [
      { status: 'waiting' },
      {
        status: 'auto_approved',
        autoReason: 'cycle_end',
        decidedAt: { gte: new Date(now.getTime() - CYCLE_END_REVIEW_MS) },
        AND: [unset('decidedById'), unset('takenBackAt')],
      },
    ],
  };
}

/** The child's own points from a completion, not taken back (hundredths). */
async function childPoints(db: Tx, completionId: string, childId: string): Promise<number> {
  const awards = await db.pointAward.findMany({
    where: { completionId, userId: childId, ...NOT_VOIDED },
    select: { pointsCenti: true },
  });
  return awards.reduce((sum, a) => sum + a.pointsCenti, 0);
}

// --- Deciding -------------------------------------------------------------------

/**
 * An adult who looks after the child decides a check (POST
 * /api/tasks/submissions/decide):
 * - waiting "task" check, approve: the task goes back to how it was, then the
 *   child completes it as of when they sent it, points landing now.
 * - waiting "task" check, send back (a note): the task goes back to how it
 *   was; the steps listed are unticked and lose their queued points; the
 *   rest stay ticked with theirs.
 * - counted as done when its day ended (3 days): approve clears it from To
 *   check; send back takes the child's points from that completion back,
 *   once. The task stays done for that day.
 * Cycles roll first, so a check whose day just ended is decided as what it
 * now is. Returns the task and, for an approval, the completion (for Undo).
 */
export async function decideSubmission(
  householdId: string,
  actor: Actor,
  input: DecideSubmissionInput,
): Promise<{ taskId: string; completionId: string | null }> {
  const before = await prisma.taskSubmission.findFirst({
    where: { id: input.submissionId, householdId },
    select: { taskId: true, status: true },
  });
  if (!before) throw new NotFoundError('That check wasn’t found.');
  await rollTaskCycles(householdId, new Date(), before.taskId);
  const settings = await getPointsSettings(householdId);
  const now = new Date();
  let ready: string | null = null;
  const wake: string[] = [];

  const completionId = await prisma
    .$transaction(async (tx): Promise<string | null> => {
      const check = await tx.taskSubmission.findFirst({ where: { id: input.submissionId, householdId } });
      if (!check) throw new NotFoundError('That check wasn’t found.');
      // Steps checks are decided once they exist (nothing creates them yet).
      if (check.kind !== 'task') throw new ConflictError('This can’t be decided yet. Update Our Home, then try again.');
      if (!(await supervisesNow(tx, householdId, actor.id, check.userId))) {
        throw new ForbiddenError('Only an adult who looks after them can decide this.');
      }
      // Its day ended while the adult was looking: it counted as done, so a
      // send back would now take points back. Let them look again first.
      if (before.status === 'waiting' && check.status === 'auto_approved') {
        throw new ConflictError('This was counted as done when the day ended. Look at it again.');
      }
      const child = await tx.user.findFirst({
        where: { id: check.userId, householdId },
        select: { id: true, name: true, role: true },
      });
      const task = await tx.task.findFirst({
        where: { id: check.taskId, householdId },
        include: { subtasks: { orderBy: { position: 'asc' } } },
      });
      if (!child || !task) throw new NotFoundError('That check wasn’t found.');
      const supervisors = await currentSupervisors(tx, householdId, check.userId);
      wake.push(child.id, ...supervisors);

      if (check.status === 'waiting') {
        if (input.decision === 'approve') {
          const paid = await payCheckInTx(tx, { householdId, check, child, settings, now });
          await tx.taskSubmission.update({
            where: { id: check.id },
            data: {
              status: 'approved',
              decidedById: actor.id,
              decidedAt: now,
              completionId: paid.completionId,
              photoDeleteAt: new Date(now.getTime() + PHOTO_KEEP_MS),
            },
          });
          const points = await childPoints(tx, paid.completionId, child.id);
          await clearReviewBells(tx, householdId, check.id);
          await tellChild(tx, householdId, check, `Approved: ${task.title}${points > 0 ? ` (+${formatPoints(points)} pts)` : ''}`);
          await logActivity(
            {
              householdId,
              actorId: actor.id,
              verb: 'updated',
              subjectType: 'task',
              subjectId: task.id,
              message: `approved ${child.name}’s “${task.title}”`,
            },
            tx,
          );
          ready = paid.ready;
          return paid.completionId;
        }

        const redo = [...new Set(input.redoStepIds ?? [])];
        const steps = new Set(task.subtasks.map((s) => s.id));
        if (redo.some((id) => !steps.has(id))) {
          throw new UnprocessableError('Pick steps from this task.', 'redoStepIds');
        }
        await tx.task.update({ where: { id: task.id }, data: { status: statusBefore(check.prevStatus) } });
        if (redo.length) {
          // Steps to do again: unticked, their queued points dropped. The
          // rest stay ticked and keep theirs.
          await tx.subtask.updateMany({ where: { taskId: task.id, id: { in: redo } }, data: UNCHECKED });
          await tx.pendingCredit.deleteMany({ where: { taskId: task.id, subtaskId: { in: redo } } });
        }
        await tx.taskSubmission.update({
          where: { id: check.id },
          data: {
            status: 'sent_back',
            decidedById: actor.id,
            decidedAt: now,
            reviewNote: input.reviewNote,
            redoStepIds: redo,
            photoDeleteAt: new Date(now.getTime() + PHOTO_KEEP_MS),
          },
        });
        await clearReviewBells(tx, householdId, check.id);
        await tellChild(tx, householdId, check, `Sent back: ${task.title}`, input.reviewNote ?? null);
        // No note here: Activity is for the whole household.
        await logActivity(
          {
            householdId,
            actorId: actor.id,
            verb: 'updated',
            subjectType: 'task',
            subjectId: task.id,
            message: `sent “${task.title}” back to ${child.name}`,
          },
          tx,
        );
        return null;
      }

      // Counted as done when its day ended: still the adults' to look at for 3 days.
      const cycleEnd = check.status === 'auto_approved' && check.autoReason === 'cycle_end';
      if (!cycleEnd || check.decidedById || check.takenBackAt) throw new ConflictError(ALREADY_DECIDED);
      if (!check.decidedAt || now.getTime() - check.decidedAt.getTime() > CYCLE_END_REVIEW_MS) {
        throw new ConflictError(TOO_LATE);
      }
      if (input.decision === 'approve') {
        // Seen and fine: it leaves To check. Who said so is kept on the check.
        await tx.taskSubmission.update({ where: { id: check.id }, data: { decidedById: actor.id } });
        return null;
      }
      if (check.completionId) {
        // Only the child's own points from that completion; anyone else's stay.
        await tx.pointAward.updateMany({
          where: { completionId: check.completionId, userId: check.userId, ...NOT_VOIDED },
          data: { voidedAt: now, voidedById: actor.id, voidReason: 'Points taken back' },
        });
      }
      await tx.taskSubmission.update({
        where: { id: check.id },
        data: { takenBackAt: now, takenBackById: actor.id, reviewNote: input.reviewNote },
      });
      await tellChild(tx, householdId, check, `Points taken back: ${task.title}`, input.reviewNote ?? null);
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'task',
          subjectId: task.id,
          message: `took back ${child.name}’s points for “${task.title}”`,
        },
        tx,
      );
      return null;
    })
    .catch(plainConflict);

  if (completionId) {
    // Paid as of when it was sent: a cycle that ended since rolls over now.
    await rollTaskCycles(householdId, new Date(), before.taskId);
    pushTaskReady(householdId, [ready]);
  }
  wakeForChecks(householdId, wake);
  return { taskId: before.taskId, completionId };
}

/**
 * The child takes back their own waiting check (POST
 * /api/tasks/submissions/withdraw, also the send toast's Undo): the task goes
 * back to how it was, the photo is deleted, the supervisors' bell rows go.
 */
export async function withdrawSubmission(householdId: string, actor: Actor, submissionId: string): Promise<string> {
  const before = await prisma.taskSubmission.findFirst({
    where: { id: submissionId, householdId },
    select: { taskId: true },
  });
  if (!before) throw new NotFoundError('That check wasn’t found.');
  await rollTaskCycles(householdId, new Date(), before.taskId);
  const now = new Date();
  const wake: string[] = [];
  await prisma
    .$transaction(async (tx) => {
      const check = await tx.taskSubmission.findFirst({ where: { id: submissionId, householdId } });
      if (!check) throw new NotFoundError('That check wasn’t found.');
      if (check.userId !== actor.id) throw new ForbiddenError('Only the person who sent it can take it back.');
      if (check.kind !== 'task' || check.status !== 'waiting') throw new ConflictError(ALREADY_DECIDED);
      await withdrawInTx(tx, householdId, check, now);
      wake.push(...(await currentSupervisors(tx, householdId, check.userId)));
    })
    .catch(plainConflict);
  wakeForChecks(householdId, wake);
  return before.taskId;
}

// --- Settling checks nobody can decide --------------------------------------------

/**
 * Checks nobody can decide any more, after supervision or roles changed (and
 * in every sweep): a child who is gone or no longer a teen or child has their
 * check withdrawn, unpaid; a child nobody looks after now, or whose checks
 * were turned off on a task that doesn't ask for a photo, has it counted as
 * done ("unsupervised") with the photo deleted at once. Anything else waits
 * on. Tasks left waiting with nothing to wait for are opened again first.
 * Logs one line per change, ids only. Returns how many checks changed.
 */
export async function settleOrphanedSubmissions(householdId: string, now: Date = new Date()): Promise<number> {
  const stuck = await prisma.task.findMany({
    where: { householdId, status: 'awaiting_review' },
    select: { id: true, status: true },
  });
  for (const task of stuck) await healAwaitingReview(prisma, task);

  // Steps checks are settled here as well once they exist (nothing creates them yet).
  const waiting = await prisma.taskSubmission.findMany({
    where: { householdId, kind: 'task', status: 'waiting' },
    select: { id: true, taskId: true },
  });
  if (waiting.length === 0) return 0;
  const settings = await getPointsSettings(householdId);
  let changed = 0;
  for (const { id, taskId } of waiting) {
    try {
      const wake: string[] = [];
      let ready: string | null = null;
      const outcome = await prisma.$transaction(async (tx): Promise<'withdrawn' | 'auto_approved' | null> => {
        const check = await tx.taskSubmission.findFirst({ where: { id, householdId } });
        if (!check || check.status !== 'waiting') return null;
        const child = await tx.user.findFirst({ where: { id: check.userId, householdId }, select: { id: true, role: true } });
        const supervisors = await currentSupervisors(tx, householdId, check.userId);
        if (!child || !canBeSupervised(child.role)) {
          await withdrawInTx(tx, householdId, check, now);
          wake.push(...supervisors);
          return 'withdrawn';
        }
        const task = await tx.task.findFirst({ where: { id: check.taskId, householdId }, select: { photoProof: true } });
        if (!task || (await needsCheck(tx, householdId, child.id, task))) return null;
        const paid = await payCheckInTx(tx, { householdId, check, child, settings, now });
        await tx.taskSubmission.update({
          where: { id: check.id },
          data: {
            status: 'auto_approved',
            autoReason: 'unsupervised',
            decidedById: null,
            decidedAt: now,
            completionId: paid.completionId,
            takenBackAt: null,
          },
        });
        // Nobody is left to look at it.
        await tx.taskPhoto.deleteMany({ where: { submissionId: check.id } });
        await clearReviewBells(tx, householdId, check.id);
        ready = paid.ready;
        wake.push(child.id, ...supervisors);
        return 'auto_approved';
      });
      if (!outcome) continue;
      changed += 1;
      console.log(`[tasks] settled check ${id} on task ${taskId}: ${outcome}`);
      if (outcome === 'auto_approved') {
        await rollTaskCycles(householdId, new Date(), taskId);
        pushTaskReady(householdId, [ready]);
      }
      wakeForChecks(householdId, wake);
    } catch (err) {
      // One bad check mustn't stop the others; the sweep tries again.
      console.error(`[tasks] settling check ${id} failed; retrying next sweep`, err);
    }
  }
  return changed;
}

/** Deletes the photos of checks decided more than 14 days ago (the sweep). */
export async function deleteExpiredPhotos(householdId: string, now: Date = new Date()): Promise<number> {
  const photos = await prisma.taskPhoto.findMany({ where: { householdId }, select: { submissionId: true } });
  if (photos.length === 0) return 0;
  const due = await prisma.taskSubmission.findMany({
    where: { householdId, id: { in: photos.map((p) => p.submissionId) }, photoDeleteAt: { lte: now } },
    select: { id: true },
  });
  if (due.length === 0) return 0;
  const res = await prisma.taskPhoto.deleteMany({ where: { householdId, submissionId: { in: due.map((d) => d.id) } } });
  return res.count;
}

// --- Reading ----------------------------------------------------------------------

/** A "steps" check's frozen entries, as stored (JSON). */
interface StoredEntry {
  subtaskId: string;
  title: string;
  pointsCenti: number;
  checkedAt: string;
  awardKind: 'step' | 'step_repeat';
  completionId?: string | null;
}

function parseEntries(raw: string | null): StoredEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * GET /api/tasks/submissions: the checks in the viewer's To check (children
 * they look after now) and their own, oldest first, with what each needs:
 * its steps, note, whether it has a photo, points, and what the viewer may do.
 * Never filtered by anyone named in the request.
 */
export async function listSubmissions(householdId: string, viewerId: string, now: Date = new Date()): Promise<TaskSubmissionDTO[]> {
  await rollTaskCycles(householdId, now);
  const kids = await supervisedNow(prisma, householdId, viewerId);
  const rows = await prisma.taskSubmission.findMany({
    where: { householdId, userId: { in: [...kids, viewerId] }, ...toCheckWhere(now) },
    orderBy: { submittedAt: 'asc' },
  });
  if (rows.length === 0) return [];

  const entriesOf = new Map(rows.map((r) => [r.id, parseEntries(r.entries)]));
  const completionIds = [
    ...new Set([...entriesOf.values()].flatMap((list) => list.map((e) => e.completionId).filter((id): id is string => !!id))),
  ];
  const paidIds = rows.filter((r) => r.status === 'auto_approved' && r.completionId).map((r) => r.completionId!);
  const [tasks, members, photos, completions, awards, settings] = await Promise.all([
    prisma.task.findMany({
      where: { householdId, id: { in: [...new Set(rows.map((r) => r.taskId))] } },
      include: { subtasks: { orderBy: { position: 'asc' } } },
    }),
    prisma.user.findMany({ where: { householdId }, select: { id: true, name: true } }),
    prisma.taskPhoto.findMany({ where: { householdId, submissionId: { in: rows.map((r) => r.id) } }, select: { submissionId: true } }),
    completionIds.length
      ? prisma.taskCompletion.findMany({ where: { id: { in: completionIds } }, select: { id: true, userId: true } })
      : Promise.resolve([]),
    paidIds.length
      ? prisma.pointAward.findMany({
          where: { householdId, completionId: { in: paidIds }, ...NOT_VOIDED },
          select: { completionId: true, userId: true, pointsCenti: true },
        })
      : Promise.resolve([]),
    getPointsSettings(householdId),
  ]);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const names = new Map(members.map((m) => [m.id, m.name]));
  const withPhoto = new Set(photos.map((p) => p.submissionId));
  const completer = new Map(completions.map((c) => [c.id, c.userId]));
  const person = (id: string | null | undefined) => (id ? { id, name: names.get(id) ?? 'Former member' } : null);

  return rows.flatMap((r): TaskSubmissionDTO[] => {
    const task = taskById.get(r.taskId);
    if (!task) return [];
    const entries: TaskSubmissionEntryDTO[] = entriesOf.get(r.id)!.map((e) => ({
      subtaskId: e.subtaskId,
      title: e.title,
      points: e.pointsCenti / 100,
      checkedAt: e.checkedAt,
      awardKind: e.awardKind,
      completionId: e.completionId ?? null,
      completedBy: person(e.completionId ? completer.get(e.completionId) : null),
    }));
    const waiting = r.status === 'waiting';
    const pointsCenti = !waiting
      ? awards.filter((a) => a.completionId === r.completionId && a.userId === r.userId).reduce((s, a) => s + a.pointsCenti, 0)
      : r.kind === 'steps'
        ? entries.reduce((s, e) => s + Math.round(e.points * 100), 0)
        : liveTotals(effectivePoints(task, settings.minutesPerPoint)).pointsCenti;
    const ticked = new Set(r.stepIds);
    const actions: TaskSubmissionAction[] = kids.has(r.userId)
      ? ['approve', 'send_back']
      : r.userId === viewerId && waiting && r.kind === 'task'
        ? ['withdraw']
        : [];
    return [
      {
        id: r.id,
        kind: r.kind === 'steps' ? 'steps' : 'task',
        status: r.status,
        autoReason: r.autoReason,
        task: { id: task.id, title: task.title },
        child: person(r.userId)!,
        submittedAt: r.submittedAt.toISOString(),
        note: r.note,
        hasPhoto: withPhoto.has(r.id),
        points: pointsCenti / 100,
        steps: task.subtasks.map((s) => ({ id: s.id, title: s.title, ticked: ticked.has(s.id) })),
        stepsTicked: task.subtasks.filter((s) => ticked.has(s.id)).length,
        decideBy: waiting
          ? (r.cycleEndsAt?.toISOString() ?? null)
          : r.decidedAt
            ? new Date(r.decidedAt.getTime() + CYCLE_END_REVIEW_MS).toISOString()
            : null,
        entries,
        actions,
      },
    ];
  });
}

/**
 * How many checks wait on [viewerId] in To check right now (children they
 * look after): the dashboard's Needs you line, like countRequestsWaitingOn.
 */
export async function countTasksToCheck(householdId: string, viewerId: string, now: Date = new Date()): Promise<number> {
  const kids = await supervisedNow(prisma, householdId, viewerId);
  if (kids.size === 0) return 0;
  return prisma.taskSubmission.count({ where: { householdId, userId: { in: [...kids] }, ...toCheckWhere(now) } });
}

/**
 * A check's photo (GET /api/tasks/submissions/photo), for the child who sent
 * it and the adults who look after them now. Not found for anyone else, so
 * nobody else can tell it exists.
 */
export async function submissionPhoto(householdId: string, viewerId: string, submissionId: string): Promise<Uint8Array> {
  const check = await prisma.taskSubmission.findFirst({
    where: { id: submissionId, householdId },
    select: { id: true, userId: true },
  });
  const allowed =
    !!check && (check.userId === viewerId || (await supervisesNow(prisma, householdId, viewerId, check.userId)));
  const photo = allowed ? await prisma.taskPhoto.findUnique({ where: { submissionId: check!.id }, select: { jpeg: true } }) : null;
  if (!photo) throw new NotFoundError('No photo for that check.');
  return photo.jpeg;
}
