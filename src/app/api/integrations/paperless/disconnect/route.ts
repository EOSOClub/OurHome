import { ok, requirePermission, withAuth } from '@/server/api/http';
import { removePaperlessConnection } from '@/server/services/paperlessSync';

// Forget the household's own Paperless connection (Head of House).
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  return ok(await removePaperlessConnection(ctx.user.householdId!));
});
