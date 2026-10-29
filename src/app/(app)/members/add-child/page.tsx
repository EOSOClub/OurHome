import { requireUser } from '@/server/auth/session';
import { can, canBeSupervised } from '@/lib/permissions';
import { listMembers } from '@/server/services/userService';
import { getSupervision } from '@/server/services/supervisionService';
import { isFeatureEnabled } from '@/server/services/serverAdminService';
import { getAppRelease } from '@/server/services/appDownloadService';
import { AddChildWizard } from '@/components/members/add-child-wizard';

// Set up a child: Head of House only, because choosing who supervises a child
// is the Head's (supervisionService). ?member= reopens it at the installation
// step for a child or teen already added.
export default async function AddChildPage({
  searchParams,
}: {
  searchParams: Promise<{ member?: string | string[] }>;
}) {
  const user = await requireUser();
  if (!can(user.role, 'household:manage')) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Set up a child</h1>
        <p className="text-sm text-muted-foreground">
          Only the Head of House can set up a child here, because the Head chooses who supervises them. You can still
          add them with Add a member on the Members page.
        </p>
      </div>
    );
  }

  const householdId = user.householdId!;
  const { member } = await searchParams;
  const [supervision, locationOn, members] = await Promise.all([
    getSupervision(householdId),
    isFeatureEnabled(householdId, 'location').catch(() => true),
    typeof member === 'string' ? listMembers(householdId) : Promise.resolve([]),
  ]);
  const kid = members.find((m) => m.id === member && canBeSupervised(m.role));
  const release = getAppRelease();

  return (
    <AddChildWizard
      actorId={user.id}
      supervision={supervision}
      locationOn={locationOn}
      app={release ? { server: release.server } : null}
      resume={
        kid
          ? {
              id: kid.id,
              name: kid.name,
              username: kid.username ?? '',
              password: null,
              supervisorIds: supervision.supervised.find((s) => s.id === kid.id)?.supervisorIds ?? [],
            }
          : null
      }
    />
  );
}
