import { fail, ok, requirePermission, withAuth } from '@/server/api/http';
import { getPaperlessStatus, hasPaperless, runPaperlessSync } from '@/server/services/paperlessSync';
import { can } from '@/lib/permissions';

// Settings → "Check now": run this household's import immediately instead of
// waiting for the 15-minute sweep. A Paperless problem comes back as a
// readable 502.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const householdId = ctx.user.householdId!;
  if (!(await hasPaperless(householdId))) {
    return fail('Paperless isn’t set up for this household.', 409);
  }
  try {
    await runPaperlessSync(householdId);
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Paperless import failed.', 502);
  }
  return ok(await getPaperlessStatus(householdId, can(ctx.user.role, 'household:manage')));
});
