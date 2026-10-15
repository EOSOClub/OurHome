import { ok, withAuth } from '@/server/api/http';
import { sendTestPush } from '@/server/services/pushService';

// "Send me a test notification" from the app's Profile: a push to the signed-in
// member's own phones, through Firebase and any open Stay connected stream.
export const POST = withAuth(async (ctx) => {
  return ok(await sendTestPush(ctx.user.householdId!, ctx.user.id));
});
