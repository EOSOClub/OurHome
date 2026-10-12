import type { Prisma } from '@prisma/client';
import { prisma } from '@/server/db/prisma';
import { logActivity } from '@/server/services/activityService';
import { ForbiddenError, NotFoundError } from '@/server/services/errors';
import { ROLE_RANK, isUserRole } from '@/lib/enums';
import { can, canBeSupervised, canSupervise } from '@/lib/permissions';
import type { SupervisionDTO } from '@/lib/types';
import type { SetSupervisorsInput } from '@/lib/validation/supervision';

// Parental controls, step 1: the Head of House's list of which adults
// supervise which children and teens. The rules live in src/lib/permissions.ts
// (canSupervise / canBeSupervised); this keeps the list.

type Db = Prisma.TransactionClient | typeof prisma;

type Person = { id: string; name: string; role: string };

function byRankThenName(a: Person, b: Person): number {
  const ra = isUserRole(a.role) ? ROLE_RANK[a.role] : 0;
  const rb = isUserRole(b.role) ? ROLE_RANK[b.role] : 0;
  if (ra !== rb) return rb - ra;
  return a.name.localeCompare(b.name);
}

/** Everything the Members → Supervision card shows. */
export async function getSupervision(householdId: string): Promise<SupervisionDTO> {
  const [users, links] = await Promise.all([
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true, role: true },
    }),
    prisma.supervision.findMany({
      where: { householdId },
      select: { supervisorId: true, supervisedId: true },
    }),
  ]);
  const people = [...users].sort(byRankThenName);
  const supervisors = people.filter((u) => canSupervise(u.role));
  const linked = new Set(links.map((l) => `${l.supervisorId}:${l.supervisedId}`));
  return {
    supervisors: supervisors.map(({ id, name, role }) => ({ id, name, role })),
    // Built from the current roles, so a link whose roles no longer fit never shows.
    supervised: people
      .filter((u) => canBeSupervised(u.role))
      .map(({ id, name, role }) => ({
        id,
        name,
        role,
        supervisorIds: supervisors.filter((s) => linked.has(`${s.id}:${id}`)).map((s) => s.id),
      })),
  };
}

/**
 * Replace who supervises one child or teen (Head of House only). Every
 * supervisor must be an adult or above in the same household.
 */
export async function setSupervisors(
  householdId: string,
  actor: { id: string; role: string },
  input: SetSupervisorsInput,
): Promise<SupervisionDTO> {
  if (!can(actor.role, 'household:manage')) {
    throw new ForbiddenError('Only the Head of House can choose who supervises whom.');
  }
  const supervised = await prisma.user.findFirst({
    where: { id: input.supervisedId, householdId },
    select: { id: true, name: true, role: true },
  });
  if (!supervised) throw new NotFoundError('That member is not in this household.');
  if (!canBeSupervised(supervised.role)) {
    throw new ForbiddenError(`${supervised.name} can’t be supervised: only children and teens can.`);
  }

  const wanted = [...new Set(input.supervisorIds)];
  const supervisors = wanted.length
    ? await prisma.user.findMany({
        where: { id: { in: wanted }, householdId },
        select: { id: true, name: true, role: true },
      })
    : [];
  if (supervisors.length !== wanted.length) {
    throw new NotFoundError('That member is not in this household.');
  }
  const notAdult = supervisors.find((s) => !canSupervise(s.role));
  if (notAdult) {
    throw new ForbiddenError(`${notAdult.name} can’t supervise anyone: only adults, managers and the Head of House can.`);
  }

  const current = await prisma.supervision.findMany({
    where: { supervisedId: supervised.id },
    select: { supervisorId: true },
  });
  const currentIds = new Set(current.map((c) => c.supervisorId));
  const added = wanted.filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !wanted.includes(id));

  if (added.length || removed.length) {
    const names = supervisors.sort(byRankThenName).map((s) => s.name);
    await prisma.$transaction(async (tx) => {
      if (removed.length) {
        await tx.supervision.deleteMany({
          where: { supervisedId: supervised.id, supervisorId: { in: removed } },
        });
      }
      if (added.length) {
        await tx.supervision.createMany({
          data: added.map((supervisorId) => ({
            householdId,
            supervisorId,
            supervisedId: supervised.id,
            createdById: actor.id,
          })),
        });
      }
      await logActivity(
        {
          householdId,
          actorId: actor.id,
          verb: 'updated',
          subjectType: 'member',
          subjectId: supervised.id,
          message: names.length
            ? `set who supervises ${supervised.name}: ${names.join(', ')}`
            : `removed everyone supervising ${supervised.name}`,
        },
        tx,
      );
    });
  }

  return getSupervision(householdId);
}

/**
 * After someone's role changes: remove the links the new role no longer
 * allows (a supervisor who is no longer an adult, or a child or teen who
 * grew into an adult role).
 */
export async function dropBrokenSupervision(db: Db, userId: string, role: string): Promise<void> {
  if (!canSupervise(role)) await db.supervision.deleteMany({ where: { supervisorId: userId } });
  if (!canBeSupervised(role)) await db.supervision.deleteMany({ where: { supervisedId: userId } });
}
