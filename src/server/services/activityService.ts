import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { areaOf, subjectFilter, type ActivityArea } from '@/lib/activityAreas';

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
  /** Id of the last entry already shown; the page continues after it. */
  before?: string;
  limit?: number;
}

/**
 * One page of the activity log, newest first, for the Activity page (web
 * /activity, app ⋮ → Activity). `nextBefore` continues it; null at the end.
 */
export async function listActivity(householdId: string, query: ActivityQuery = {}) {
  const take = Math.min(100, query.limit ?? 50);
  const rows = await prisma.activityEntry.findMany({
    where: {
      householdId,
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

export type ActivityPage = Awaited<ReturnType<typeof listActivity>>;
