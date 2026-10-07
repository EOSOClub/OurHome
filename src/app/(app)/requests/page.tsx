import { requireUser } from '@/server/auth/session';
import { prisma } from '@/server/db/prisma';
import { can } from '@/lib/permissions';
import { listRequests, requestToDTO } from '@/server/services/requestService';
import { getUserAccess } from '@/server/services/permissionService';
import { RequestsView } from '@/components/requests/requests-view';

export default async function RequestsPage() {
  const user = await requireUser();
  const access = await getUserAccess(user);
  const householdId = user.householdId!;

  const [requests, members] = await Promise.all([
    listRequests(householdId),
    // For "who should do it?" on maintenance requests.
    prisma.user.findMany({
      where: { householdId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  return (
    <RequestsView
      initialRequests={requests.map(requestToDTO)}
      currentUserId={user.id}
      members={members}
      canSubmit={access.requests.create}
      canManageMedia={can(user.role, 'requests:manage_media')}
    />
  );
}
