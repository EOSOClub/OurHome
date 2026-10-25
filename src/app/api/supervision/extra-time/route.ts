import { ok, parseBody, withAuth } from '@/server/api/http';
import { giveExtraTime } from '@/server/services/supervisionService';
import { giveExtraTimeSchema } from '@/lib/validation/supervision';

// A supervising adult giving a child extra minutes on today's daily limits.
// The service refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, giveExtraTimeSchema);
  return ok(await giveExtraTime(ctx.user.householdId!, ctx.user, input));
});
