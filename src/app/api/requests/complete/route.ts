import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { completeRequest, requestToDTO } from '@/server/services/requestService';
import { completeRequestSchema } from '@/lib/validation/request';

// Mark a request done: maintenance (assignee), media added, or a purchase or
// permission approved (whoever decides: Settings → Request types). A purchase
// may name a shopping list to put it on. Who may handle it is enforced in the
// service.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const input = await parseBody(ctx.req, completeRequestSchema);
  const request = await completeRequest(ctx.user.householdId!, ctx.user, input);
  return ok(requestToDTO(request));
});
