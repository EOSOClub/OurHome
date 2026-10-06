import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteRequest } from '@/server/services/requestService';
import { requestIdSchema } from '@/lib/validation/request';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const { id } = await parseBody(ctx.req, requestIdSchema);
  // Ownership (requester only) is enforced in the service.
  await deleteRequest(ctx.user.householdId!, ctx.user.id, id);
  return ok({ id });
});
