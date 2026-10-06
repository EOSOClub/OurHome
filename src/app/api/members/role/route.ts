import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { setMemberRole } from '@/server/services/userService';
import { setMemberRoleSchema } from '@/lib/validation/user';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'members:manage');
  const input = await parseBody(ctx.req, setMemberRoleSchema);
  const member = await setMemberRole(ctx.user.householdId!, ctx.user, input);
  return ok(member);
});
