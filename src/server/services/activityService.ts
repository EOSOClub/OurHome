import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { areaOf, subjectFilter, type ActivityArea } from '@/lib/activityAreas';
import { hiddenSubjectTypes } from '@/lib/features';
import { markRemindersStale } from '@/server/services/reminderRuns';

type Db = typeof prisma | Prisma.TransactionClient;

export interface LogActivityInput {
  householdId: string;
  actorId?: string | null;
  verb: string;
  subjectType: string;
  subjectId?: string | null;
  message: string;
  /** Optional structured context; stored as JSON text. */
  metadata?: unknown;
}

/**
 * Append an entry to the household activity feed. Every service that mutates
 * household state should call this so the timeline stays authoritative.
 * Accepts a transaction client so the entry commits atomically with the change.
 */
export async function logActivity(input: LogActivityInput, db: Db = prisma) {
  // Every change is logged here, so it's also the signal that the household's
  // reminders may be out of date (reminderRuns): the next read rebuilds them.
  // A read landing inside the change's own transaction can still rebuild from
  // the old state; the next change, or the throttle running out a minute
  // later, catches that.
  markRemindersStale(input.householdId);
  return db.activityEntry.create({
    data: {
      householdId: input.householdId,
      actorId: input.actorId ?? null,
      verb: input.verb,
      subjectType: input.subjectType,
      subjectId: input.subjectId ?? null,
      message: input.message,
      metadata:
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
    },
  });
}

export interface ActivityQuery {
  area?: ActivityArea;
  actorId?: string;
  /** The id of the last entry already shown; the page continues after it. */
  before?: string;
  limit?: number;
}

/**
 * One page of the activity log, newest first, for the Activity page (web
 * /activity, app ⋮ → Activity). `nextBefore` continues it; null at the end.
 */
export async function listActivity(householdId: string, query: ActivityQuery = {}) {
  const take = Math.min(100, query.limit ?? 50);
  // Areas the server admin turned off for this household stay out of the log,
  // as they do from the bell. Imported here: serverAdminService logs activity
  // through this module.
  const { getHouseholdFeatures } = await import('@/server/services/serverAdminService');
  const hidden = hiddenSubjectTypes(await getHouseholdFeatures(householdId));
  const rows = await prisma.activityEntry.findMany({
    where: {
      householdId,
      ...(hidden.length ? { NOT: { subjectType: { in: hidden } } } : {}),
      ...(query.area ? { subjectType: subjectFilter(query.area) } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
    // One extra tells whether there is another page.
    take: take + 1,
    select: {
      id: true,
      verb: true,
      subjectType: true,
      subjectId: true,
      message: true,
      createdAt: true,
      actor: { select: { id: true, name: true } },
    },
  });
  const items = rows.slice(0, take).map((r) => ({ ...r, area: areaOf(r.subjectType) }));
  return {
    items,
    nextBefore: rows.length > take ? items[items.length - 1].id : null,
  };
}
