import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { getPaperlessStatus, savePaperlessConnection } from '@/server/services/paperlessSync';
import { can } from '@/lib/permissions';
import { paperlessConnectionSchema } from '@/lib/validation/integration';

// The household's Paperless bill import: status (Settings card) and its own
// connection. Seeing it needs settings:manage; changing the connection (a
// stored credential) is the Head of House's alone.
export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  return ok(await getPaperlessStatus(ctx.user.householdId!, can(ctx.user.role, 'household:manage')));
});

export const PUT = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const input = await parseBody(ctx.req, paperlessConnectionSchema);
  return ok(await savePaperlessConnection(ctx.user.householdId!, input));
});
