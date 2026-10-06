import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { requestToDTO, updateRequest } from '@/server/services/requestService';
import { updateRequestSchema } from '@/lib/validation/request';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const input = await parseBody(ctx.req, updateRequestSchema);
  // Ownership (requester only) is enforced in the service.
  const request = await updateRequest(ctx.user.householdId!, ctx.user.id, input);
  return ok(requestToDTO(request));
});
