import { fail, ok, requirePermission, withAuth } from '@/server/api/http';
import { getInboxStatus, hasInbox, runInboxSync } from '@/server/inbox/sync';
import { can } from '@/lib/permissions';

// Settings → "Check now": run this household's OurHomeInbox import
// immediately instead of waiting for the 15-minute sweep. A problem with
// OurHomeInbox comes back as a readable 502.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const householdId = ctx.user.householdId!;
  if (!(await hasInbox(householdId))) {
    return fail('OurHomeInbox isn’t set up for this household.', 409);
  }
  try {
    await runInboxSync(householdId);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'OurHomeInbox import failed.', 502);
  }
  return ok(await getInboxStatus(householdId, can(ctx.user.role, 'household:manage')));
});
