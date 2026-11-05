import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteRequestNote, requestToDTO } from '@/server/services/requestService';
import { requestIdSchema } from '@/lib/validation/request';

// Remove a note (`id`: the note's). Its author may, and so may the head
// (enforced in the service). Answers with the request without it.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const { id } = await parseBody(ctx.req, requestIdSchema);
  const request = await deleteRequestNote(ctx.user.householdId!, ctx.user, id);
  return ok(requestToDTO(request));
});
