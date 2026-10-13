import { ok, parseBody, withAuth } from '@/server/api/http';
import { getMyUsageSharing, reportUsage } from '@/server/services/appUsageService';
import { reportUsageSchema } from '@/lib/validation/phone';

// App usage (parental controls). GET: whether the signed-in member's usage is
// shared (their Profile and phone ask). POST: their phone's report; 409 while
// it isn't shared, and the phone stops measuring. The answer lists the apps
// with no icon stored yet; the phone sends those to ./icons.
export const GET = withAuth(async (ctx) => ok(await getMyUsageSharing(ctx.user.id)));

export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, reportUsageSchema);
  const { missingIcons } = await reportUsage(ctx.user.householdId!, ctx.user.id, input);
  return ok({ saved: true, missingIcons });
});
