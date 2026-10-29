import { ok, parseBody, parseQuery, withAuth } from '@/server/api/http';
import { buyExtraTime, myExtraTime } from '@/server/services/pointsTimeService';
import { buyExtraTimeSchema, extraTimeQuerySchema } from '@/lib/validation/phone';

// The member's own points for screen time: GET what they can buy on their
// phone's date (?day=YYYY-MM-DD), POST to buy minutes with points. The
// service refuses buying unless an adult who looks after them has turned it on.
export const GET = withAuth(async (ctx) => {
  const { day } = parseQuery(ctx.req, extraTimeQuerySchema);
  return ok(await myExtraTime(ctx.user.householdId!, ctx.user.id, day));
});

export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, buyExtraTimeSchema);
  return ok(await buyExtraTime(ctx.user.householdId!, ctx.user.id, input));
});
