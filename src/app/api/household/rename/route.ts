import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { renameHousehold } from '@/server/services/userService';
import { renameHouseholdSchema } from '@/lib/validation/user';

export const POST = withAuth(async (ctx) => {
  // Only the head holds household:manage; the service double-checks.
  requirePermission(ctx, 'household:manage');
  const { name } = await parseBody(ctx.req, renameHouseholdSchema);
  const household = await renameHousehold(ctx.user.householdId!, ctx.user, name);
  return ok(household);
});
