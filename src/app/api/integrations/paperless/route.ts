import { ok, requirePermission, withAuth } from '@/server/api/http';
import { getPaperlessStatus } from '@/server/services/paperlessSync';

// Status of the Paperless bill import for the Settings card.
export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  return ok(await getPaperlessStatus(ctx.user.householdId!));
});
