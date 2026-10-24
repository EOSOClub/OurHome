import { ok, parseBody, withAuth } from '@/server/api/http';
import { setAppBlocked } from '@/server/services/supervisionService';
import { setAppBlockedSchema } from '@/lib/validation/supervision';

// A supervising adult blocking an app on a child's phone, or unblocking it.
// The service refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, setAppBlockedSchema);
  return ok(await setAppBlocked(ctx.user.householdId!, ctx.user, input));
});
