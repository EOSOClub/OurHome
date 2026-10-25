import { ok, parseBody, withAuth } from '@/server/api/http';
import { saveSchedule } from '@/server/services/supervisionService';
import { saveScheduleSchema } from '@/lib/validation/supervision';

// A supervising adult adding a schedule to a child's phone, or changing one
// (with its id). The service refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, saveScheduleSchema);
  return ok(await saveSchedule(ctx.user.householdId!, ctx.user, input));
});
