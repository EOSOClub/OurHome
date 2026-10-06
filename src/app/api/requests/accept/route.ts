import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { acceptRequest, requestToDTO } from '@/server/services/requestService';
import { acceptRequestSchema } from '@/lib/validation/request';

// Accept a request: maintenance (assignee, with a done-by date, or moving it)
// or media (the head). Who may handle it is enforced in the service.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const input = await parseBody(ctx.req, acceptRequestSchema);
  const request = await acceptRequest(ctx.user.householdId!, ctx.user, input);
  return ok(requestToDTO(request));
});
