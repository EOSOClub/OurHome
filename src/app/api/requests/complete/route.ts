import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { completeRequest, requestToDTO } from '@/server/services/requestService';
import { requestIdSchema } from '@/lib/validation/request';

// Mark a request done: maintenance (assignee) or media available (the head).
// Who may handle it is enforced in the service.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const { id } = await parseBody(ctx.req, requestIdSchema);
  const request = await completeRequest(ctx.user.householdId!, ctx.user, id);
  return ok(requestToDTO(request));
});
