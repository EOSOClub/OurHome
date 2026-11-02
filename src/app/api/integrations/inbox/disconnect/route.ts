import { ok, requirePermission, withAuth } from '@/server/api/http';
import { removeInboxConnection } from '@/server/inbox/sync';

// Forget the household's OurHomeInbox connection (Head of House).
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  return ok(await removeInboxConnection(ctx.user.householdId!));
});
