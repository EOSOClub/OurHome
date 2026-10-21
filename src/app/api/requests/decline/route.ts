import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { declineRequest, requestToDTO } from '@/server/services/requestService';
import { declineRequestSchema } from '@/lib/validation/request';

// Decline a request, with an optional reason: whoever handles its kind, where
// the head allows declining (Settings → Request types). Enforced in the service.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const input = await parseBody(ctx.req, declineRequestSchema);
  const request = await declineRequest(ctx.user.householdId!, ctx.user, input);
  return ok(requestToDTO(request));
});
