import { requireUser } from '@/server/auth/session';
import { can } from '@/lib/permissions';
import { getHouseholdName, listMembers } from '@/server/services/userService';
import { MembersView } from '@/components/members/members-view';

export default async function MembersPage() {
  const user = await requireUser();

  if (!can(user.role, 'members:manage')) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Household members</h1>
        <p className="text-sm text-muted-foreground">
          Member management is handled by the Head of House or a Manager.
        </p>
      </div>
    );
  }

  const [members, householdName] = await Promise.all([
    listMembers(user.householdId!),
    getHouseholdName(user.householdId!),
  ]);
  return (
    <MembersView
      initialMembers={members}
      householdName={householdName}
      currentUser={{ id: user.id, role: user.role }}
    />
  );
}
