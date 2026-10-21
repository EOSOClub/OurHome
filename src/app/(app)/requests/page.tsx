import { requireFeature } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { listRequests, requestToDTO } from '@/server/services/requestService';
import { getUserAccess } from '@/server/services/permissionService';
import { getModuleViews } from '@/server/services/requestModuleService';
import { RequestsView } from '@/components/requests/requests-view';

export default async function RequestsPage() {
  const user = await requireFeature('requests');
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  const [requests, members, modules] = await Promise.all([
    listRequests(householdId),
    // For "who should do it?" on maintenance requests.
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    // The kinds of request that are on (Settings → Request types), as this member sees them.
    getModuleViews(householdId, user, access.requests),
  ]);

  return (
    <RequestsView
      initialRequests={requests.map(requestToDTO)}
      initialModules={modules}
      currentUserId={user.id}
      members={members}
    />
  );
}
