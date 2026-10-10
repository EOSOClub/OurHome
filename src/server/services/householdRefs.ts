import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { NotFoundError } from '@/server/services/errors';

// Ids a client sends that point at other rows (an assignee, a category) are
// only shape-checked by zod; Mongo has no foreign keys. These make sure they
// belong to the caller's household before they're stored, so nobody can
// attach another household's member or category to their rows.

type Db = Prisma.TransactionClient | typeof prisma;

/** Throws unless [userId] (when given) is a member of the household. */
export async function assertMemberRef(db: Db, householdId: string, userId: string | null | undefined): Promise<void> {
  if (!userId) return;
  const found = await db.user.findFirst({ where: { id: userId, householdId }, select: { id: true } });
  if (!found) throw new NotFoundError('That member is not in this household.');
}

/** Throws unless [roomId] / [floorId] (when given) are the household's. */
export async function assertPlaceRef(
  db: Db,
  householdId: string,
  roomId: string | null | undefined,
  floorId: string | null | undefined,
): Promise<void> {
  if (roomId) {
    const found = await db.room.findFirst({ where: { id: roomId, householdId }, select: { id: true } });
    if (!found) throw new NotFoundError('That room is not in this household.');
  }
  if (floorId) {
    const found = await db.floor.findFirst({ where: { id: floorId, householdId }, select: { id: true } });
    if (!found) throw new NotFoundError('That floor is not in this household.');
  }
}

/** Throws unless [categoryId] (when given) is one of the household's categories. */
export async function assertCategoryRef(db: Db, householdId: string, categoryId: string | null | undefined): Promise<void> {
  if (!categoryId) return;
  const found = await db.category.findFirst({ where: { id: categoryId, householdId }, select: { id: true } });
  if (!found) throw new NotFoundError('That category is not in this household.');
}
