import { ok, withAuth } from '@/server/api/http';
import { getModuleViews } from '@/server/services/requestModuleService';
import { getUserAccess } from '@/server/services/permissionService';

// The kinds of request that are on, as the caller sees them: what the form
// offers them and which kinds they handle (the Requests page and the app).
export const GET = withAuth(async ({ user }) => {
  const access = await getUserAccess(user);
  return ok(await getModuleViews(user.householdId!, user, access.requests));
});
