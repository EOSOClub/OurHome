import { ok, parseQuery, withAuth } from '@/server/api/http';
import { supervisedUsageHistory } from '@/server/services/supervisionService';
import { usageHistoryQuerySchema } from '@/lib/validation/supervision';

// Every stored day of a supervised child's app usage, with all its apps: the
// week's chart and the full list on "People you look after". The service
// refuses anyone who doesn't supervise them, and 409 while it isn't shared.
export const GET = withAuth(async (ctx) => {
  const { supervisedId } = parseQuery(ctx.req, usageHistoryQuerySchema);
  return ok(await supervisedUsageHistory(ctx.user.householdId!, ctx.user, supervisedId));
});
