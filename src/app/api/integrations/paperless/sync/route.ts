import { fail, ok, requirePermission, withAuth } from '@/server/api/http';
import { getPaperlessStatus, isPaperlessConfigured, runPaperlessSync } from '@/server/services/paperlessSync';

// Settings → "Check now": run an import pass immediately instead of waiting for
// the 15-minute sweep. A Paperless problem comes back as a readable 502.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  if (!isPaperlessConfigured()) return fail('The Paperless import is not set up on the server.', 409);
  try {
    await runPaperlessSync();
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Paperless import failed.', 502);
  }
  return ok(await getPaperlessStatus(ctx.user.householdId!));
});
