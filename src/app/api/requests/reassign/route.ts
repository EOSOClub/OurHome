import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { reassignRequest, requestToDTO } from '@/server/services/requestService';
import { reassignRequestSchema } from '@/lib/validation/request';

// Give a maintenance request to someone else: the Head of House only. Enforced in the service.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const input = await parseBody(ctx.req, reassignRequestSchema);
  const request = await reassignRequest(ctx.user.householdId!, ctx.user, input);
  return ok(requestToDTO(request));
});
