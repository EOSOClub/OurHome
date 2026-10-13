import { ok, parseBody, withAuth } from '@/server/api/http';
import { setRequiredSharing } from '@/server/services/supervisionService';
import { setRequiredSharingSchema } from '@/lib/validation/supervision';

// A supervising adult making a child's location sharing required, or not.
// The service refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, setRequiredSharingSchema);
  return ok(await setRequiredSharing(ctx.user.householdId!, ctx.user, input));
});
