import { ok, parseBody, withAuth } from '@/server/api/http';
import { reportLiveCheckFix } from '@/server/services/liveCheckService';
import { liveCheckFixSchema } from '@/lib/validation/location';

// The checked person's phone sending where it is during a live check. 409
// once the check is over: the phone stops and takes its notification down.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, liveCheckFixSchema);
  return ok(await reportLiveCheckFix(ctx.user.householdId!, ctx.user.id, input));
});
