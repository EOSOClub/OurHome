import { ok, parseBody, withAuth } from '@/server/api/http';
import { checkIn } from '@/server/services/phoneStatusService';
import { phoneCheckInSchema } from '@/lib/validation/phone';

// The Android app checking in, about hourly: which install, and whether it may
// still use location all the time and post notifications (phoneStatusService).
// Answers whether the phone must Stay connected (an adult looks after them),
// which apps their supervisors blocked, their daily limits and their schedules.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, phoneCheckInSchema);
  const answer = await checkIn(ctx.user.householdId!, ctx.user.id, input);
  return ok({ checkedIn: true, ...answer });
});
