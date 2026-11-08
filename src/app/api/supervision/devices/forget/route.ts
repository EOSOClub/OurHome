import { ok, parseBody, withAuth } from '@/server/api/http';
import { forgetDevice } from '@/server/services/supervisionService';
import { forgetDeviceSchema } from '@/lib/validation/supervision';

// A supervising adult forgetting one of a child's devices they no longer use,
// so its silence stops alerting. The service refuses anyone who doesn't
// supervise them; a device still in use comes back with its next check-in.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, forgetDeviceSchema);
  return ok(await forgetDevice(ctx.user.householdId!, ctx.user, input));
});
