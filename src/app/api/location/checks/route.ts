import { ok, parseBody, withAuth } from '@/server/api/http';
import { liveChecksOverview, startLiveCheck } from '@/server/services/liveCheckService';
import { startLiveCheckSchema } from '@/lib/validation/location';

// Live location checks. GET: the signed-in member's view (a check running on
// them, checks they started, their log, the household's limits). POST: start
// one; the service decides who may (adults, on members who allow it).
export const GET = withAuth(async (ctx) =>
  ok(await liveChecksOverview(ctx.user.householdId!, { id: ctx.user.id, role: ctx.user.role })),
);

export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, startLiveCheckSchema);
  return ok(await startLiveCheck(ctx.user.householdId!, { id: ctx.user.id, role: ctx.user.role }, input));
});
