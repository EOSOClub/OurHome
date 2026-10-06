import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { removeMember } from '@/server/services/userService';
import { memberIdSchema } from '@/lib/validation/user';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'members:manage');
  const { id } = await parseBody(ctx.req, memberIdSchema);
  await removeMember(ctx.user.householdId!, ctx.user, id);
  return ok({ id });
});
