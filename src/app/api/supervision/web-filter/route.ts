import { ok, parseBody, withAuth } from '@/server/api/http';
import { setWebFilter } from '@/server/services/supervisionService';
import { setWebFilterSchema } from '@/lib/validation/supervision';

// A supervising adult choosing the web filter on a child's phone (Family
// filter, Adult sites only), or turning it off. The service refuses anyone
// who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, setWebFilterSchema);
  return ok(await setWebFilter(ctx.user.householdId!, ctx.user, input));
});
