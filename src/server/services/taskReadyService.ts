import type { Prisma } from '@prisma/client';
import { pushSync } from '@/server/services/pushService';

// "Your turn" notices: when a task becomes someone's to do — assigned to them,
// passed to them by a rotation, or reopened for a new cycle/occurrence — its
// assignee gets a bell row (addressed to them alone) and a phone alert. At
// most one per task: a newer one replaces it, and completing, archiving or
// deleting the task removes it. Whoever caused the change (assigning a task to
// yourself, completing it and getting it straight back) isn't notified.

type Db = Prisma.TransactionClient;

export interface ReadyTask {
  id: string;
  title: string;
  assigneeId: string | null;
  dueDate: Date | null;
  rotationUserIds?: string | null;
}

/** The notice text, e.g. "It's your turn — due Fri, Oct 10." */
export function taskReadyBody(task: ReadyTask, timeZone?: string): string {
  const lead = task.rotationUserIds ? 'It’s your turn' : 'Ready for you';
  if (!task.dueDate) return `${lead}.`;
  const due = task.dueDate.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
  return `${lead} — due ${due}.`;
}

/** Removes the task's "your turn" notice, if any. */
export async function clearTaskReady(db: Db, householdId: string, taskId: string): Promise<void> {
  await db.notification.deleteMany({ where: { householdId, type: 'task_ready', subjectId: taskId } });
}

/**
 * Replaces the task's notice with a fresh, unread one for its assignee.
 * Returns who to alert (call [pushTaskReady] after the transaction commits),
 * or null when nobody is (unassigned, or the assignee caused it).
 */
export async function announceTaskReady(
  db: Db,
  householdId: string,
  task: ReadyTask,
  actorId: string | null,
  timeZone?: string,
): Promise<string | null> {
  await clearTaskReady(db, householdId, task.id);
  if (!task.assigneeId || task.assigneeId === actorId) return null;
  await db.notification.create({
    data: {
      householdId,
      userId: task.assigneeId,
      type: 'task_ready',
      title: task.title,
      body: taskReadyBody(task, timeZone),
      channel: 'in_app',
      subjectType: 'task',
      subjectId: task.id,
      // Explicit null so unread filters match (see notificationService).
      readAt: null,
    },
  });
  return task.assigneeId;
}

/** Wakes the given people's phones so the app alerts now. */
export function pushTaskReady(householdId: string, userIds: (string | null | undefined)[]): void {
  const ids = userIds.filter((id): id is string => !!id);
  if (ids.length) pushSync(householdId, { userIds: ids }, 'task');
}
