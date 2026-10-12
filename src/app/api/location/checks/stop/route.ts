import { ok, parseBody, withAuth } from '@/server/api/http';
import { stopLiveCheck } from '@/server/services/liveCheckService';
import { liveCheckIdSchema } from '@/lib/validation/location';

// Stops a live check early: the person checking, or the person checked.
export const POST = withAuth(async (ctx) => {
  const { id } = await parseBody(ctx.req, liveCheckIdSchema);
  return ok(await stopLiveCheck(ctx.user.householdId!, ctx.user.id, id));
});
