import { ok, withAuth } from '@/server/api/http';
import { phoneSetup } from '@/server/services/phoneStatusService';

// The Android app's Set up this phone checklist: what the signed-in member's
// phone must have on (notifications, location, Usage access and the
// protections their supervisors chose). Nothing while nobody looks after them.
export const GET = withAuth(async (ctx) => {
  return ok(await phoneSetup(ctx.user.householdId!, ctx.user.id));
});
