import { ok, parseQuery, withAuth } from '@/server/api/http';
import { getLiveCheck } from '@/server/services/liveCheckService';
import { liveCheckIdSchema } from '@/lib/validation/location';

// One live check (?id=), for the person checking (the map polls it) or the
// person checked (their phone). Anyone else gets 404.
export const GET = withAuth(async (ctx) => {
  const { id } = parseQuery(ctx.req, liveCheckIdSchema);
  return ok(await getLiveCheck(ctx.user.householdId!, ctx.user.id, id));
});
