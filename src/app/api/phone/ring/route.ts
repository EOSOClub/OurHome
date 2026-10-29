import { ok, parseBody, withAuth } from '@/server/api/http';
import { reportRing } from '@/server/services/supervisionService';
import { reportRingSchema } from '@/lib/validation/phone';

// A rung phone saying it's ringing, then that Stop was tapped, or that it rang out,
// for the adult who rang (People you look after). known: false for a ring the
// server no longer has; the phone has nothing to do about it.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, reportRingSchema);
  return ok(reportRing(ctx.user.householdId!, ctx.user.id, input));
});
