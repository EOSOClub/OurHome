import { ok, requireFeatureOn, withAuth } from '@/server/api/http';
import { markRequestsSeen } from '@/server/services/requestService';

// They opened Requests (website or app): the Requests badge clears on every
// device and counts again from now.
export const POST = withAuth(async (ctx) => {
  await requireFeatureOn(ctx, 'requests');
  await markRequestsSeen(ctx.user.id);
  return ok({ requestsNew: 0 });
});
