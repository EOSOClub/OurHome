import { ok, parseBody, withAuth } from '@/server/api/http';
import { refreshUsage } from '@/server/services/supervisionService';
import { refreshUsageSchema } from '@/lib/validation/supervision';

// A supervising adult opened "People you look after": wake the child's phone
// so it sends its app usage now. Quietly skipped when it can't or was just
// asked; the service refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const { supervisedId } = await parseBody(ctx.req, refreshUsageSchema);
  return ok(await refreshUsage(ctx.user.householdId!, ctx.user, supervisedId));
});
