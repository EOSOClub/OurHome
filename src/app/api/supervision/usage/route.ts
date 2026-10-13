import { ok, parseBody, withAuth } from '@/server/api/http';
import { setUsageSharing } from '@/server/services/supervisionService';
import { setUsageSharingSchema } from '@/lib/validation/supervision';

// A supervising adult turning a child's app usage sharing on or off. The
// service refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, setUsageSharingSchema);
  return ok(await setUsageSharing(ctx.user.householdId!, ctx.user, input));
});
