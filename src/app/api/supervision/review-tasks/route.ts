import { ok, parseBody, withAuth } from '@/server/api/http';
import { setReviewTasks } from '@/server/services/supervisionService';
import { setReviewTasksSchema } from '@/lib/validation/supervision';

// A supervising adult turning "Check their tasks before points" on or off for
// a child. The service refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, setReviewTasksSchema);
  return ok(await setReviewTasks(ctx.user.householdId!, ctx.user, input));
});
