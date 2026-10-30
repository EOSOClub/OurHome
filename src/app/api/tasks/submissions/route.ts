import { ok, withAuth } from '@/server/api/http';
import { listSubmissions } from '@/server/services/taskSubmissionService';

// Task checks (Task Photo Proof): To check for an adult (the children they
// look after now) and the caller's own waiting checks, with what each needs
// and what the caller may do. Filtered by the session alone, never by anyone
// named in the request.
export const GET = withAuth(async (ctx) => {
  return ok(await listSubmissions(ctx.user.householdId!, ctx.user.id));
});
