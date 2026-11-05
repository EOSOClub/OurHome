import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { addRequestNote, requestToDTO } from '@/server/services/requestService';
import { addRequestNoteSchema } from '@/lib/validation/request';

// Add a note to a request, for the whole household to read. Anyone who works
// with requests may; the kind must be on (checked in the service).
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const input = await parseBody(ctx.req, addRequestNoteSchema);
  const request = await addRequestNote(ctx.user.householdId!, ctx.user, input);
  return ok(requestToDTO(request), { status: 201 });
});
