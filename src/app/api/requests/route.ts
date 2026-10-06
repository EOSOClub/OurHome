import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import {
  createRequest,
  listRequests,
  requestToDTO,
} from '@/server/services/requestService';
import { createRequestSchema } from '@/lib/validation/request';

export const GET = withAuth(async ({ user }) => {
  const requests = await listRequests(user.householdId!);
  return ok(requests.map(requestToDTO));
});

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const input = await parseBody(ctx.req, createRequestSchema);
  const request = await createRequest(ctx.user.householdId!, ctx.user.id, input);
  return ok(requestToDTO(request), { status: 201 });
});
