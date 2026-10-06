import { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';

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

export async function listRecentActivity(householdId: string, take = 20) {
  return prisma.activityEntry.findMany({
    where: { householdId },
    orderBy: { createdAt: 'desc' },
    take,
    include: { actor: { select: { id: true, name: true } } },
  });
}
