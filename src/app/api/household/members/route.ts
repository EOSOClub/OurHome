import { ok, withAuth } from '@/server/api/http';
import { prisma } from '@/server/db/prisma';

// Lightweight member list (id + name) for pickers — e.g. choosing who should
// handle a maintenance request. Any household member may read it; the full
// management view stays behind members:manage at /api/members.
export const GET = withAuth(async ({ user }) => {
  const members = await prisma.user.findMany({
    where: { householdId: user.householdId! },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });
  return ok(members);
});
