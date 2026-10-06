import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { createMember, listMembers } from '@/server/services/userService';
import { createMemberSchema } from '@/lib/validation/user';

export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'members:manage');
  const members = await listMembers(ctx.user.householdId!);
  return ok(members);
});

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'members:manage');
  const input = await parseBody(ctx.req, createMemberSchema);
  const member = await createMember(ctx.user.householdId!, ctx.user, input);
  return ok(member, { status: 201 });
});
