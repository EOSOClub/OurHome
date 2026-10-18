import { ok, parseBody, withAuth } from '@/server/api/http';
import { reportNewApps } from '@/server/services/appUsageService';
import { reportNewAppsSchema } from '@/lib/validation/phone';

// Apps a child's phone found since it last looked: their supervisors get a
// bell alert. 409 while their app usage isn't shared.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, reportNewAppsSchema);
  return ok(await reportNewApps(ctx.user.householdId!, ctx.user.id, input));
});
