import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { transferHeadship } from '@/server/services/userService';
import { memberIdSchema } from '@/lib/validation/user';

export const POST = withAuth(async (ctx) => {
  // Only the head holds household:manage; the service double-checks.
  requirePermission(ctx, 'household:manage');
  const { id } = await parseBody(ctx.req, memberIdSchema);
  const member = await transferHeadship(ctx.user.householdId!, ctx.user, id);
  return ok(member);
});
