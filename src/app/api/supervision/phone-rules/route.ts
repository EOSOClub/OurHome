import { ok, parseBody, withAuth } from '@/server/api/http';
import { setPhoneRule } from '@/server/services/supervisionService';
import { setPhoneRuleSchema } from '@/lib/validation/supervision';

// A supervising adult requiring a protection on a child's phone (Keep Our
// Home running, Prevent uninstall, Unrestricted battery), or no longer. The
// service refuses anyone who doesn't supervise them.
export const POST = withAuth(async (ctx) => {
  const input = await parseBody(ctx.req, setPhoneRuleSchema);
  return ok(await setPhoneRule(ctx.user.householdId!, ctx.user, input));
});
