import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { resetMemberPassword } from '@/server/services/userService';
import { resetMemberPasswordSchema } from '@/lib/validation/user';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'members:manage');
  const input = await parseBody(ctx.req, resetMemberPasswordSchema);
  const member = await resetMemberPassword(ctx.user.householdId!, ctx.user, input);
  return ok(member);
});
