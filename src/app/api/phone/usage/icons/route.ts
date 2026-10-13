import { ok, parseBody, withAuth } from '@/server/api/http';
import { reportIcons } from '@/server/services/appUsageService';
import { reportUsageIconsSchema } from '@/lib/validation/phone';

// App usage (parental controls): the phone sending the app icons the server
// asked for after its usage report. 409 while the member's usage isn't shared.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, reportUsageIconsSchema);
  return ok(await reportIcons(ctx.user.householdId!, ctx.user.id, input));
});
