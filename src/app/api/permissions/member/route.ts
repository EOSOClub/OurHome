import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { setMemberAccess } from '@/server/services/permissionService';
import { setMemberAccessSchema } from '@/lib/validation/permissions';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const input = await parseBody(ctx.req, setMemberAccessSchema);
  return ok(
    await setMemberAccess(
      ctx.user.householdId!,
      ctx.user.id,
      input.memberId,
      input.access,
    ),
  );
});
