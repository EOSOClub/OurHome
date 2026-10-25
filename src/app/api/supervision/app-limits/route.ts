import { ok, parseBody, withAuth } from '@/server/api/http';
import { setAppLimit } from '@/server/services/supervisionService';
import { setAppLimitSchema } from '@/lib/validation/supervision';

// A supervising adult setting, changing or removing a daily limit on a
// child's phone (one app, or "*" for all apps together). The service refuses
// anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, setAppLimitSchema);
  return ok(await setAppLimit(ctx.user.householdId!, ctx.user, input));
});
