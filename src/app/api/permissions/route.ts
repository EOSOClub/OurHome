import { ok, requirePermission, withAuth } from '@/server/api/http';
import { getAccessSettings } from '@/server/services/permissionService';

// The head's permissions editor: role defaults + every member's grid.
export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  return ok(await getAccessSettings(ctx.user.householdId!));
});
