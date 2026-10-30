import type { Prisma } from '@prisma/client';
import { canBeSupervised, canSupervise } from '@/lib/permissions';
import { supervisorsOf } from '@/server/services/pointsTimeService';
import { pushSync } from '@/server/services/pushService';

// Task Photo Proof: a child or teen sends a task (with a photo, or a note)
// for a check by the adults who supervise them, and its points are paid when
// one of them approves it (TaskSubmission, TaskPhoto). Supervision is the
// authority over a child: only their current supervisors review, so every
// rule here re-checks both roles (src/lib/permissions.ts canSupervise /
// canBeSupervised) at the moment it's asked.

type Tx = Prisma.TransactionClient;

/**
 * Whether [userId] sends [task] for a check instead of completing it: a teen
 * or child with at least one current supervisor, when a supervisor turned on
 * "Check their tasks before points" for them (User.reviewTasks) or the task
 * asks for a photo (Task.photoProof). Read inside the caller's transaction,
 * so it holds for the write that follows. Never asked when an approved check
 * is being paid (completeInTx with a submissionId).
 */
export async function needsCheck(
  tx: Tx,
  householdId: string,
  userId: string,
  task: { photoProof?: boolean | null },
): Promise<boolean> {
  const user = await tx.user.findFirst({
    where: { id: userId, householdId },
    select: { role: true, reviewTasks: true },
  });
  if (!user || !canBeSupervised(user.role)) return false;
  if (user.reviewTasks !== true && task.photoProof !== true) return false;
  const links = await tx.supervision.findMany({
    where: { householdId, supervisedId: userId },
    select: { supervisor: { select: { role: true } } },
  });
  return links.some((l) => canSupervise(l.supervisor.role));
}

/**
 * A task left waiting for an OK (awaiting_review) with no "task" submission
 * waiting would never roll over or be completed again. Wherever a task is
 * read for rolling, settling, completing or step checks, such a task is
 * treated as, and written back to, pending. Returns the task as it now
 * stands; logs one server line (ids only) when it changes something.
 */
export async function healAwaitingReview<T extends { id: string; status: string }>(tx: Tx, task: T): Promise<T> {
  if (task.status !== 'awaiting_review') return task;
  const waiting = await tx.taskSubmission.findFirst({
    where: { taskId: task.id, kind: 'task', status: 'waiting' },
    select: { id: true },
  });
  if (waiting) return task;
  await tx.task.update({ where: { id: task.id }, data: { status: 'pending' } });
  console.warn(`[tasks] task ${task.id} was waiting for a check with none waiting; set back to pending`);
  return { ...task, status: 'pending' };
}

// --- Shared by sending, deciding, undoing and settling checks ------------------

/** Bell row for each supervisor when a child sends a task for a check. */
export const TASK_REVIEW_TYPE = 'task_review';
/** Bell row for the child when their check is decided. */
export const TASK_REVIEWED_TYPE = 'task_reviewed';
/** Most waiting checks a child may have started themselves; more would bury the adults. */
export const MAX_WAITING_CHECKS = 10;
/** A decided check keeps its photo this long, then the sweep deletes it. */
export const PHOTO_KEEP_MS = 14 * 86_400_000;
/** How long a check counted as done when its day ended stays in To check. */
export const CYCLE_END_REVIEW_MS = 3 * 86_400_000;
/** Said for anything that would change a task while it waits for an OK. */
export const WAITING_FOR_OK = 'This is waiting for an adult’s OK. Take it back to change it.';
/** Said when a decision lost a race with another one (or its state moved on). */
export const ALREADY_DECIDED = 'Someone already decided this.';

/** Status the task goes back to when a check ends without paying: what it was when sent. */
export function statusBefore(prevStatus: string | null | undefined): string {
  return prevStatus === 'in_progress' ? 'in_progress' : 'pending';
}

/** The adults who look after [childId] right now (both roles still fit). */
export function currentSupervisors(db: Tx, householdId: string, childId: string): Promise<string[]> {
  return supervisorsOf(db, householdId, childId);
}

/**
 * Whether [supervisorId] looks after [childId] right now: the same rule as
 * supervisionService.isSupervising (both roles re-checked), read in the
 * caller's transaction so it holds for what it decides.
 */
export async function supervisesNow(db: Tx, householdId: string, supervisorId: string, childId: string): Promise<boolean> {
  return (await currentSupervisors(db, householdId, childId)).includes(supervisorId);
}

/** The children and teens [viewerId] looks after right now (as supervisionService.supervisedIds). */
export async function supervisedNow(db: Tx, householdId: string, viewerId: string): Promise<Set<string>> {
  const links = await db.supervision.findMany({
    where: { householdId, supervisorId: viewerId },
    select: { supervisedId: true, supervisor: { select: { role: true } }, supervised: { select: { role: true } } },
  });
  return new Set(
    links.filter((l) => canSupervise(l.supervisor.role) && canBeSupervised(l.supervised.role)).map((l) => l.supervisedId),
  );
}

/** A teen or child someone looks after right now: they can't change whether a task asks for a photo. */
export async function isSupervisedChild(db: Tx, householdId: string, userId: string): Promise<boolean> {
  const user = await db.user.findFirst({ where: { id: userId, householdId }, select: { role: true } });
  if (!user || !canBeSupervised(user.role)) return false;
  return (await currentSupervisors(db, householdId, userId)).length > 0;
}

/** The "task" check waiting on [taskId], if any (at most one). */
export function waitingCheck(db: Tx, taskId: string) {
  return db.taskSubmission.findFirst({ where: { taskId, kind: 'task', status: 'waiting' } });
}

/**
 * Whether [actor] may undo the completion an approved check paid: the adult
 * who approved it, within the undo window, while they still look after the
 * child; or the head. Never one counted as done on its own (auto_approved).
 * A missing check (deleted since) is left to the head.
 */
export function mayUndoCheck(
  check: { status: string; decidedById: string | null; decidedAt: Date | null } | null | undefined,
  actor: { id: string; role: string },
  now: Date,
  supervising: boolean,
  windowMs: number,
): boolean {
  if (check?.status === 'auto_approved') return false;
  if (actor.role === 'head') return true;
  return (
    !!check &&
    check.status === 'approved' &&
    check.decidedById === actor.id &&
    !!check.decidedAt &&
    now.getTime() - check.decidedAt.getTime() <= windowMs &&
    supervising
  );
}

// Bell rows. Each supervisor's row is keyed by the check, so a decision,
// take-back or undo can remove all of them; the child has one row per check,
// replaced by each newer answer. Plain text only: no photo, no note on the
// supervisors' rows, nothing that can act from a notification.

function reviewKey(submissionId: string, supervisorId: string): string {
  return `${TASK_REVIEW_TYPE}:${submissionId}:${supervisorId}`;
}

function reviewedKey(submissionId: string): string {
  return `${TASK_REVIEWED_TYPE}:${submissionId}`;
}

/** Removes every supervisor's bell row for the check. */
export async function clearReviewBells(db: Tx, householdId: string, submissionId: string): Promise<void> {
  await db.notification.deleteMany({
    where: { householdId, type: TASK_REVIEW_TYPE, dedupeKey: { startsWith: `${TASK_REVIEW_TYPE}:${submissionId}:` } },
  });
}

/** One bell row per current supervisor ("Riley sent “Dishes” for a check"), replacing any already there. */
export async function askSupervisors(
  db: Tx,
  householdId: string,
  check: { id: string; taskId: string },
  childName: string,
  taskTitle: string,
  supervisorIds: string[],
): Promise<void> {
  await clearReviewBells(db, householdId, check.id);
  if (supervisorIds.length === 0) return;
  await db.notification.createMany({
    data: supervisorIds.map((userId) => ({
      householdId,
      userId,
      type: TASK_REVIEW_TYPE,
      title: `${childName} sent “${taskTitle}” for a check`,
      body: null,
      channel: 'in_app',
      subjectType: 'task',
      subjectId: check.taskId,
      dedupeKey: reviewKey(check.id, userId),
      // Explicit null so unread filters match (see notificationService).
      readAt: null,
    })),
  });
}

/** Removes the child's answer row for the check, if any. */
export async function clearChildBell(db: Tx, householdId: string, submissionId: string): Promise<void> {
  await db.notification.deleteMany({ where: { householdId, type: TASK_REVIEWED_TYPE, dedupeKey: reviewedKey(submissionId) } });
}

/** Tells the child what happened to their check ("Approved: Dishes (+5 pts)"), replacing an older answer. */
export async function tellChild(
  db: Tx,
  householdId: string,
  check: { id: string; taskId: string; userId: string },
  title: string,
  body: string | null = null,
): Promise<void> {
  await clearChildBell(db, householdId, check.id);
  await db.notification.create({
    data: {
      householdId,
      userId: check.userId,
      type: TASK_REVIEWED_TYPE,
      title,
      body,
      channel: 'in_app',
      subjectType: 'task',
      subjectId: check.taskId,
      dedupeKey: reviewedKey(check.id),
      readAt: null,
    },
  });
}

/** Wakes these people's phones so their bell catches up now (after the transaction commits). */
export function wakeForChecks(householdId: string, userIds: (string | null | undefined)[]): void {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length) pushSync(householdId, { userIds: ids }, 'task');
}

/**
 * Ends a waiting check without paying it: the task goes back to how it was
 * when sent, the photo is deleted at once, and the supervisors' bell rows go
 * (the caller wakes their phones after commit).
 */
export async function withdrawInTx(
  db: Tx,
  householdId: string,
  check: { id: string; taskId: string; userId: string; kind: string; prevStatus: string | null },
  now: Date,
): Promise<void> {
  await db.taskSubmission.update({ where: { id: check.id }, data: { status: 'withdrawn', decidedAt: now } });
  await db.taskPhoto.deleteMany({ where: { submissionId: check.id } });
  await clearReviewBells(db, householdId, check.id);
  if (check.kind === 'task') {
    // Only a task still waiting for this check goes back; never one moved on since.
    await db.task.updateMany({
      where: { id: check.taskId, status: 'awaiting_review' },
      data: { status: statusBefore(check.prevStatus) },
    });
  }
}
