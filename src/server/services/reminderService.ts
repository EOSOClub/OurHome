import { prisma } from '@/server/db/prisma';
import { dateBefore, dateOnOrBefore } from '@/server/db/dateFilters';
import { sendEmail } from '@/server/email/mailer';
import { buildReminderEmail } from '@/server/email/notificationEmail';
import { pushSync } from '@/server/services/pushService';
import { membersWithAccess } from '@/server/services/permissionService';
import type { AccessPage } from '@/lib/permissions';
import type { NotificationType } from '@/lib/enums';

// Turns current household state (overdue tasks, low / soon-depleted inventory,
// upcoming/overdue unpaid bills) into notifications. The *selection* logic is
// kept as pure functions so it can be unit-tested without a database (see
// reminderService.test.ts); only `generateReminders` touches Prisma.

/** Days of look-ahead before a predicted depletion becomes a reminder. */
export const REORDER_WINDOW_DAYS = 3;

const ACTIVE_STATUSES = ['pending', 'in_progress'];

/** Notification types this generator owns. Used to scope stale cleanup so it
 *  never deletes manually-created "system" notifications. */
export const MANAGED_TYPES: NotificationType[] = [
  'overdue',
  'low_inventory',
  'reminder',
  'bill_due',
];

export interface ReminderCandidate {
  dedupeKey: string;
  type: NotificationType;
  title: string;
  body: string | null;
  subjectType: string;
  subjectId: string;
  /** Who sees it: the people tied to the subject (assignee, creator), plus
   *  the page's managers once [withManagers] has run. */
  audienceUserIds: string[];
}

export interface TaskLike {
  id: string;
  title: string;
  dueDate: Date | null;
  status: string;
  assigneeId?: string | null;
  createdById?: string | null;
}

export interface InventoryLike {
  id: string;
  name: string;
  unit: string | null;
  quantity: number;
  isLow: boolean;
  predictedDepletionAt: Date | null;
  createdById?: string | null;
}

export interface BillLike {
  id: string;
  name: string;
  dueDate: Date | null;
  status: string;
  assignedUserId?: string | null;
  createdById?: string | null;
}

/** Distinct, non-empty user ids. */
export function tiedUsers(...ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Overdue = active task whose due date is strictly in the past. */
export function buildOverdueReminders(
  tasks: TaskLike[],
  now: Date,
): ReminderCandidate[] {
  return tasks
    .filter(
      (t) =>
        ACTIVE_STATUSES.includes(t.status) &&
        t.dueDate !== null &&
        t.dueDate.getTime() < now.getTime(),
    )
    .map((t) => ({
      dedupeKey: `overdue:task:${t.id}`,
      type: 'overdue',
      title: t.title,
      body: 'This task is past its due date.',
      subjectType: 'task',
      subjectId: t.id,
      audienceUserIds: tiedUsers(t.assigneeId, t.createdById),
    }));
}

/**
 * Low-stock items become a `low_inventory` notification; items predicted to
 * deplete within the window (and not already flagged low) become a `reminder`.
 */
export function buildInventoryReminders(
  items: InventoryLike[],
  now: Date,
  windowDays = REORDER_WINDOW_DAYS,
): ReminderCandidate[] {
  const horizon = now.getTime() + windowDays * 24 * 60 * 60 * 1000;
  const out: ReminderCandidate[] = [];

  for (const item of items) {
    if (item.isLow) {
      const left =
        item.unit !== null ? ` — ${item.quantity} ${item.unit} left` : '';
      out.push({
        dedupeKey: `low_inventory:inventory_item:${item.id}`,
        type: 'low_inventory',
        title: item.name,
        body: `Running low${left}.`,
        subjectType: 'inventory_item',
        subjectId: item.id,
        audienceUserIds: tiedUsers(item.createdById),
      });
      continue; // a low item is already actionable; skip the softer reminder.
    }
    if (
      item.predictedDepletionAt !== null &&
      item.predictedDepletionAt.getTime() <= horizon
    ) {
      out.push({
        dedupeKey: `reminder:inventory_item:${item.id}`,
        type: 'reminder',
        title: item.name,
        body: 'Predicted to run out soon — consider restocking.',
        subjectType: 'inventory_item',
        subjectId: item.id,
        audienceUserIds: tiedUsers(item.createdById),
      });
    }
  }

  return out;
}

/**
 * Unpaid bills due within the look-ahead window — or already past due — become
 * a `bill_due` notification. One stable dedupe key per bill, so a bill that
 * slides from "due soon" into "overdue" refreshes its body in place instead of
 * stacking a second notification.
 */
export function buildBillReminders(
  bills: BillLike[],
  now: Date,
  windowDays = REORDER_WINDOW_DAYS,
): ReminderCandidate[] {
  const horizon = now.getTime() + windowDays * 24 * 60 * 60 * 1000;
  return bills
    .filter(
      (b) =>
        b.status === 'unpaid' &&
        b.dueDate !== null &&
        b.dueDate.getTime() <= horizon,
    )
    .map((b) => ({
      dedupeKey: `bill_due:bill:${b.id}`,
      type: 'bill_due' as const,
      title: b.name,
      body:
        b.dueDate!.getTime() < now.getTime()
          ? 'This bill is past its due date and still unpaid.'
          : 'This bill is due soon.',
      subjectType: 'bill',
      subjectId: b.id,
      audienceUserIds: tiedUsers(b.assignedUserId, b.createdById),
    }));
}

/** All reminder candidates for the given state. */
export function buildReminders(
  tasks: TaskLike[],
  items: InventoryLike[],
  bills: BillLike[],
  now: Date,
  windowDays = REORDER_WINDOW_DAYS,
): ReminderCandidate[] {
  return [
    ...buildOverdueReminders(tasks, now),
    ...buildInventoryReminders(items, now, windowDays),
    ...buildBillReminders(bills, now, windowDays),
  ];
}

/**
 * Candidates whose dedupeKey is not among the household's existing generated
 * notifications — i.e. the ones the upsert will *create* rather than refresh.
 * Only these trigger an email; refreshes stay silent.
 */
export function selectNewReminders(
  candidates: ReminderCandidate[],
  existingKeys: Iterable<string>,
): ReminderCandidate[] {
  const existing = new Set(existingKeys);
  return candidates.filter((c) => !existing.has(c.dedupeKey));
}

/** The page whose managers hear about each kind of subject. */
const SUBJECT_PAGE: Record<string, AccessPage> = {
  task: 'tasks',
  bill: 'bills',
  inventory_item: 'inventory',
};

/**
 * Adds each subject's managers — whoever the page-access grid lets edit
 * other people's entries on that page (head only for tasks; head, manager and
 * member for bills and stock by default) — to the people tied to it.
 */
export function withManagers(
  candidates: ReminderCandidate[],
  managers: Partial<Record<AccessPage, string[]>>,
): ReminderCandidate[] {
  return candidates.map((c) => ({
    ...c,
    audienceUserIds: tiedUsers(
      ...c.audienceUserIds,
      ...(managers[SUBJECT_PAGE[c.subjectType]] ?? []),
    ),
  }));
}

/** The members who see [candidate]: its audience. Mirrors
 *  notificationService.visibleTo. */
export function reminderRecipients<M extends { id: string }>(
  candidate: ReminderCandidate,
  members: M[],
): M[] {
  return members.filter((m) => candidate.audienceUserIds.includes(m.id));
}

/** Minimal shape of the mail sender so tests can inject a stub. */
export type ReminderEmailSender = (args: {
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

/**
 * Reconcile the household's generated notifications with current state:
 * upsert a notification for each candidate (idempotent via the
 * `(householdId, dedupeKey)` unique index) and delete any previously-generated
 * notification whose condition no longer holds. Manually-created "system"
 * notifications are never touched.
 *
 * Newly-created notifications (not refreshes of an existing dedupeKey) are also
 * emailed to every household member as a best-effort side effect. The rows stay
 * channel `in_app` — they remain the source of truth; email failures are logged
 * and never break generation. `send` is injectable for tests.
 */
export async function generateReminders(
  householdId: string,
  send: ReminderEmailSender = sendEmail,
): Promise<void> {
  const now = new Date();
  const horizon = new Date(now.getTime() + REORDER_WINDOW_DAYS * 86_400_000);

  const [tasks, items, bills] = await Promise.all([
    prisma.task.findMany({
      where: {
        householdId,
        status: { in: ACTIVE_STATUSES },
        dueDate: dateBefore(now),
      },
      select: {
        id: true,
        title: true,
        dueDate: true,
        status: true,
        assigneeId: true,
        createdById: true,
      },
    }),
    prisma.inventoryItem.findMany({
      where: {
        householdId,
        OR: [{ isLow: true }, { predictedDepletionAt: dateOnOrBefore(horizon) }],
      },
      select: {
        id: true,
        name: true,
        unit: true,
        quantity: true,
        isLow: true,
        predictedDepletionAt: true,
        createdById: true,
      },
    }),
    prisma.bill.findMany({
      where: {
        householdId,
        status: 'unpaid',
        dueDate: dateOnOrBefore(horizon),
      },
      select: {
        id: true,
        name: true,
        dueDate: true,
        status: true,
        assignedUserId: true,
        createdById: true,
      },
    }),
  ]);

  const [taskManagers, billManagers, stockManagers] = await Promise.all([
    membersWithAccess(householdId, 'tasks', 'editOthers'),
    membersWithAccess(householdId, 'bills', 'editOthers'),
    membersWithAccess(householdId, 'inventory', 'editOthers'),
  ]);
  const candidates = withManagers(buildReminders(tasks, items, bills, now), {
    tasks: taskManagers,
    bills: billManagers,
    inventory: stockManagers,
  });
  const keep = candidates.map((c) => c.dedupeKey);

  // Snapshot existing generated keys so we can tell created from refreshed:
  // upsert alone doesn't report which branch it took. Read just before the
  // transaction — a concurrent run could at worst duplicate a best-effort email.
  const existing = await prisma.notification.findMany({
    where: {
      householdId,
      type: { in: MANAGED_TYPES },
      dedupeKey: { not: null },
    },
    select: { dedupeKey: true },
  });
  const created = selectNewReminders(
    candidates,
    existing.map((n) => n.dedupeKey!),
  );

  await prisma.$transaction(async (tx) => {
    for (const c of candidates) {
      await tx.notification.upsert({
        where: { householdId_dedupeKey: { householdId, dedupeKey: c.dedupeKey } },
        // Refresh the human-readable fields if state changed; leave the read
        // state (readByUserIds) alone so a notification someone dismissed
        // doesn't come back for them while it persists. The audience follows
        // reassignment and grid changes.
        update: { title: c.title, body: c.body, type: c.type, audienceUserIds: c.audienceUserIds },
        create: {
          householdId,
          type: c.type,
          title: c.title,
          body: c.body,
          channel: 'in_app',
          subjectType: c.subjectType,
          subjectId: c.subjectId,
          dedupeKey: c.dedupeKey,
          audienceUserIds: c.audienceUserIds,
          // Write the field explicitly so unread rows match `readAt: null`
          // (Mongo leaves an omitted optional field unset; see notificationService).
          readAt: null,
        },
      });
    }

    // Drop generated notifications whose underlying condition cleared.
    await tx.notification.deleteMany({
      where: {
        householdId,
        type: { in: MANAGED_TYPES },
        dedupeKey: { notIn: keep },
      },
    });
  });

  // Wake the phones of whoever can see a new row so the app alerts now rather
  // than on its next hourly check. Only for new rows: refreshes are silent
  // there too.
  if (created.length > 0) {
    pushSync(householdId, { userIds: created.flatMap((c) => c.audienceUserIds) }, 'reminder');
  }

  // Best-effort email for the newly-created notifications, after the rows are
  // committed. Each goes to the members who see it in the bell (its
  // audience). Any failure is logged and swallowed — email must never break
  // reminder generation.
  if (created.length > 0) {
    try {
      const members = await prisma.user.findMany({
        where: { householdId },
        select: { id: true, email: true },
      });
      await Promise.all(
        created.flatMap((c) => {
          const { subject, text } = buildReminderEmail(c);
          return reminderRecipients(c, members).map((m) =>
            send({ to: m.email, subject, text }).catch((err) => {
              console.warn(
                `[reminders] failed to email ${m.email} for ${c.dedupeKey}:`,
                err,
              );
            }),
          );
        }),
      );
    } catch (err) {
      console.warn('[reminders] failed to send reminder emails:', err);
    }
  }
}
