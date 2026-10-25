import { ok, parseBody, withAuth } from '@/server/api/http';
import { removeSchedule } from '@/server/services/supervisionService';
import { removeScheduleSchema } from '@/lib/validation/supervision';

// A supervising adult removing a schedule from a child's phone. The service
// refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, removeScheduleSchema);
  return ok(await removeSchedule(ctx.user.householdId!, ctx.user, input));
});
