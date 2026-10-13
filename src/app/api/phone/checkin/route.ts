import { ok, parseBody, withAuth } from '@/server/api/http';
import { checkIn } from '@/server/services/phoneStatusService';
import { phoneCheckInSchema } from '@/lib/validation/phone';

// The Android app checking in, about hourly: which install, and whether it may
// still use location all the time and post notifications (phoneStatusService).
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, phoneCheckInSchema);
  await checkIn(ctx.user.householdId!, ctx.user.id, input);
  return ok({ checkedIn: true });
});
