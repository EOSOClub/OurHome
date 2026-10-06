import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { updateMember } from '@/server/services/userService';
import { updateMemberSchema } from '@/lib/validation/user';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'members:manage');
  const input = await parseBody(ctx.req, updateMemberSchema);
  const member = await updateMember(ctx.user.householdId!, ctx.user, input);
  return ok(member);
});
