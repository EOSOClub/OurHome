import { ok, parseBody, withAuth } from '@/server/api/http';
import { setPointsForTime } from '@/server/services/supervisionService';
import { setPointsForTimeSchema } from '@/lib/validation/supervision';

// A supervising adult letting a child spend points on screen time (what a
// point buys and the most a day), or stopping it. The service refuses anyone
// who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, setPointsForTimeSchema);
  return ok(await setPointsForTime(ctx.user.householdId!, ctx.user, input));
});
