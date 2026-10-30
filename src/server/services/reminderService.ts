import { prisma } from '@/server/db/prisma';
import { dateBefore, dateOnOrBefore } from '@/server/db/dateFilters';
import { sendEmail } from '@/server/email/mailer';
import { buildReminderEmail } from '@/server/email/notificationEmail';
import { pushSync } from '@/server/services/pushService';
import { membersWithAccess } from '@/server/services/permissionService';
import type { AccessPage } from '@/lib/permissions';
import type { NotificationType } from '@/lib/enums';
import { isOverdue } from '@/lib/format';
import { getPointsSettings } from '@/server/services/pointsService';
import { getHouseholdFeatures } from '@/server/services/serverAdminService';
import { listOccurrences } from '@/server/services/calendarService';
import { addDays, daysBetween, localDateOf, localTimeAt, startOfLocalDate } from '@/lib/taskCycles';

// Turns current household state (overdue tasks, low / soon-depleted inventory,
// upcoming/overdue unpaid bills, free trials about to end, calendar events
// whose reminder time came) into
// notifications. The *selection* logic is
// kept as pure functions so it can be unit-tested without a database (see
// reminderService.test.ts); only `generateReminders` touches Prisma.

/** Days of look-ahead: an item predicted to run out within this many days gets a reminder. */
export const REORDER_WINDOW_DAYS = 3;

const ACTIVE_STATUSES = ['pending', 'in_progress'];

/** How far back and ahead the sweep looks for event dates with a reminder. */
const EVENT_LOOKBACK_MS = 26 * 60 * 60 * 1000;
const EVENT_LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;

/** Notification types this generator owns. Used to scope stale cleanup so it
 *  never deletes manually created "system" notifications. */
export const MANAGED_TYPES: NotificationType[] = [
  'overdue',
  'low_inventory',
  'reminder',
  'bill_due',
  'event_reminder',
  'subscription_trial',
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

/**
 * Overdue = active task past its due date: a date-only one (stored at 12:00
 * local) from the next day in the household's zone, a timed one once its
 * time passed - the same rule the pages show (lib/format isOverdue).
 */
export function buildOverdueReminders(
  tasks: TaskLike[],
  now: Date,
  timeZone?: string,
): ReminderCandidate[] {
  return tasks
    .filter(
      (t) =>
        ACTIVE_STATUSES.includes(t.status) &&
        t.dueDate !== null &&
        isOverdue(t.dueDate, timeZone, now),
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
        item.unit !== null ? ` - ${item.quantity} ${item.unit} left` : '';
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
        body: 'Predicted to run out soon - consider restocking.',
        subjectType: 'inventory_item',
        subjectId: item.id,
        audienceUserIds: tiedUsers(item.createdById),
      });
    }
  }

  return out;
}

/**
 * Unpaid bills due within the look-ahead window - or already past due - become
 * a `bill_due` notification. One stable dedupe key per bill, so a bill that
 * slides from "due soon" into "overdue" refreshes its body in place instead of
 * stacking a second notification.
 */
export function buildBillReminders(
  bills: BillLike[],
  now: Date,
  windowDays = REORDER_WINDOW_DAYS,
  timeZone?: string,
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
        isOverdue(b.dueDate, timeZone, now)
          ? 'This bill is past its due date and still unpaid.'
          : 'This bill is due soon.',
      subjectType: 'bill',
      subjectId: b.id,
      audienceUserIds: tiedUsers(b.assignedUserId, b.createdById),
    }));
}

export interface TrialLike {
  id: string;
  name: string;
  trialEndsAt: Date;
  assignedUserId?: string | null;
  createdById?: string | null;
}

/** A free trial ending is said this many days ahead. */
export const TRIAL_NOTICE_DAYS = 3;

/**
 * A subscription whose free trial ends soon becomes a `subscription_trial`:
 * from 3 days before the day it ends until that day is over (household zone),
 * so there's time to cancel before it charges. One per subscription; the
 * text counts down each sweep.
 */
export function buildTrialReminders(
  subscriptions: TrialLike[],
  now: Date,
  timeZone: string,
): ReminderCandidate[] {
  const today = localDateOf(now, timeZone);
  const out: ReminderCandidate[] = [];
  for (const s of subscriptions) {
    const day = localDateOf(s.trialEndsAt, timeZone);
    const from = startOfLocalDate(addDays(day, -TRIAL_NOTICE_DAYS), timeZone);
    const until = startOfLocalDate(addDays(day, 1), timeZone);
    if (now < from || now >= until) continue;
    const left = daysBetween(today, day);
    out.push({
      dedupeKey: `subscription_trial:bill:${s.id}`,
      type: 'subscription_trial',
      title: s.name,
      body:
        left <= 0
          ? "Its free trial ends today. Cancel today if you don't want to pay for it."
          : `Its free trial ends ${left === 1 ? 'tomorrow' : `in ${left} days`}. Cancel before then if you don't want to pay for it.`,
      subjectType: 'bill',
      subjectId: s.id,
      audienceUserIds: tiedUsers(s.assignedUserId, s.createdById),
    });
  }
  return out;
}

export interface EventReminderLike {
  eventId: string;
  title: string;
  location?: string | null;
  start: Date;
  end: Date | null;
  allDay: boolean;
  /** Minutes before the start (all-day: before 9:00 on the day); null = none. */
  reminderMinutes: number | null;
  attendeeIds: string[];
  createdById: string | null;
}

/** All-day events remind counting back from this local time on their day. */
export const ALL_DAY_REMINDER_HOUR = 9;
/** A timed event without an end keeps its reminder this long after it starts. */
const NO_END_MS = 60 * 60 * 1000;

/**
 * When one date's reminder shows (`fireAt`) and when it's gone (`until`, once
 * that date's event is over): a timed event counts back from its start and
 * lasts until its end (or an hour); an all-day one counts back from 9:00 on
 * its day, household time, and lasts until its last day is over.
 */
export function eventReminderWindow(
  o: EventReminderLike,
  timeZone: string,
): { fireAt: Date; until: Date } | null {
  if (o.reminderMinutes === null) return null;
  const before = o.reminderMinutes * 60_000;
  if (!o.allDay) {
    return {
      fireAt: new Date(o.start.getTime() - before),
      until: o.end ?? new Date(o.start.getTime() + NO_END_MS),
    };
  }
  const day = localDateOf(o.start, timeZone);
  const lastDay = localDateOf(o.end ?? o.start, timeZone);
  return {
    fireAt: new Date(localTimeAt(day, ALL_DAY_REMINDER_HOUR, 0, timeZone).getTime() - before),
    until: startOfLocalDate(addDays(lastDay, 1), timeZone),
  };
}

/** "Today at 3:00 PM", "Tomorrow, all day", "Fri, Nov 6 at 9:30 AM". */
function eventWhen(o: EventReminderLike, now: Date, timeZone: string): string {
  const diff = daysBetween(localDateOf(now, timeZone), localDateOf(o.start, timeZone));
  const day =
    diff === 0
      ? 'Today'
      : diff === 1
        ? 'Tomorrow'
        : o.start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone });
  if (o.allDay) return `${day}, all day`;
  const time = o.start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone });
  return `${day} at ${time}`;
}

/**
 * Events whose reminder time has come and that aren't over yet become an
 * `event_reminder` for their attendees and creator. One per date (the key has
 * the date's start), so each date of a repeating event reminds on its own.
 * The text is refreshed each sweep, so "Tomorrow" turns into "Today".
 */
export function buildEventReminders(
  occurrences: EventReminderLike[],
  now: Date,
  timeZone: string,
): ReminderCandidate[] {
  const out: ReminderCandidate[] = [];
  for (const o of occurrences) {
    const window = eventReminderWindow(o, timeZone);
    if (!window || now < window.fireAt || now >= window.until) continue;
    const where = o.location ? ` (${o.location})` : '';
    out.push({
      dedupeKey: `event_reminder:event:${o.eventId}:${o.start.toISOString()}`,
      type: 'event_reminder',
      title: o.title,
      body: `${eventWhen(o, now, timeZone)}${where}.`,
      subjectType: 'event',
      subjectId: o.eventId,
      audienceUserIds: tiedUsers(...o.attendeeIds, o.createdById),
    });
  }
  return out;
}

/** All reminder candidates for the given state. */
export function buildReminders(
  tasks: TaskLike[],
  items: InventoryLike[],
  bills: BillLike[],
  now: Date,
  windowDays = REORDER_WINDOW_DAYS,
  timeZone?: string,
): ReminderCandidate[] {
  return [
    ...buildOverdueReminders(tasks, now, timeZone),
    ...buildInventoryReminders(items, now, windowDays),
    ...buildBillReminders(bills, now, windowDays, timeZone),
  ];
}

/**
 * Candidates whose dedupeKey is not among the household's existing generated
 * notifications - i.e., the ones the upsert will *create* rather than refresh.
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
 * Adds each subject's managers - whoever the page-access grid lets edit
 * other people's entries on that page (head only for tasks; head, manager, and
 * member for bills and stock by default) - to the people tied to it.
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
 * `(householdId, dedupeKey)` unique index) and delete any previously generated
 * notification whose condition no longer holds. Manually created "system"
 * notifications are never touched.
 *
 * Newly created notifications (not refreshes of an existing dedupeKey) are also
 * emailed to every household member as a best-effort side effect. The rows stay
 * channel `in_app` - they remain the source of truth; email failures are logged
 * and never break generation. `send` is injectable for tests.
 */
export async function generateReminders(
  householdId: string,
  send: ReminderEmailSender = sendEmail,
): Promise<void> {
  const now = new Date();
  const horizon = new Date(now.getTime() + REORDER_WINDOW_DAYS * 86_400_000);
  // A feature the server admin turned off has no reminders; its old rows are
  // cleared below like any other condition that no longer holds.
  const features = await getHouseholdFeatures(householdId);
  const none = Promise.resolve([]);

  const [tasks, items, bills, trials] = await Promise.all([
    !features.includes('tasks') ? none : prisma.task.findMany({
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
    !features.includes('inventory') ? none : prisma.inventoryItem.findMany({
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
    !features.includes('bills') ? none : prisma.bill.findMany({
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
    // Trials ending from yesterday (still today somewhere) to the notice ahead.
    !features.includes('bills') ? none : prisma.bill.findMany({
      where: {
        householdId,
        kind: 'subscription',
        trialEndsAt: {
          gte: new Date(now.getTime() - EVENT_LOOKBACK_MS),
          lte: new Date(now.getTime() + (TRIAL_NOTICE_DAYS + 1) * 86_400_000),
        },
      },
      select: {
        id: true,
        name: true,
        trialEndsAt: true,
        assignedUserId: true,
        createdById: true,
      },
    }),
  ]);

  const [taskManagers, billManagers, stockManagers, settings, occurrences] = await Promise.all([
    membersWithAccess(householdId, 'tasks', 'editOthers'),
    membersWithAccess(householdId, 'bills', 'editOthers'),
    membersWithAccess(householdId, 'inventory', 'editOthers'),
    getPointsSettings(householdId),
    // Dates that started up to a day ago (still on) or start within a week
    // and a bit (the earliest reminder is a week ahead of 9:00 on the day).
    !features.includes('calendar')
      ? Promise.resolve([])
      : listOccurrences(
          householdId,
          new Date(now.getTime() - EVENT_LOOKBACK_MS),
          new Date(now.getTime() + EVENT_LOOKAHEAD_MS),
        ),
  ]);
  const events: EventReminderLike[] = occurrences
    .filter((o) => o.reminderMinutes !== null)
    .map((o) => ({
      eventId: o.eventId,
      title: o.title,
      location: o.location,
      start: new Date(o.start),
      end: o.end ? new Date(o.end) : null,
      allDay: o.allDay,
      reminderMinutes: o.reminderMinutes,
      attendeeIds: o.attendees.map((a) => a.id),
      createdById: o.createdById,
    }));
  const candidates = [
    ...withManagers([
      ...buildReminders(tasks, items, bills, now, REORDER_WINDOW_DAYS, settings.timezone),
      ...buildTrialReminders(
        trials.map((t) => ({ ...t, trialEndsAt: t.trialEndsAt! })),
        now,
        settings.timezone,
      ),
    ], {
      tasks: taskManagers,
      bills: billManagers,
      inventory: stockManagers,
    }),
    // Only the people on the event: no managers added.
    ...buildEventReminders(events, now, settings.timezone),
  ];
  const keep = candidates.map((c) => c.dedupeKey);

  // Snapshot existing generated keys so we can tell created from refreshed:
  // upsert alone doesn't report which branch it took. Read just before the
  // transaction - a concurrent run could at worst duplicate a best-effort email.
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

  // Best-effort email for the newly created notifications, after the rows are
  // committed. Each goes to the members who see it in the bell (its
  // audience). Any failure is logged and swallowed - email must never break
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
