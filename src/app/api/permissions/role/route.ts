import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { setRoleAccess } from '@/server/services/permissionService';
import { setRoleAccessSchema } from '@/lib/validation/permissions';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const input = await parseBody(ctx.req, setRoleAccessSchema);
  return ok(
    await setRoleAccess(ctx.user.householdId!, ctx.user.id, input.role, input.access),
  );
});
