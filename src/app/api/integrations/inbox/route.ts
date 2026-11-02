import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { getInboxStatus, saveInboxConnection } from '@/server/inbox/sync';
import { can } from '@/lib/permissions';
import { inboxConnectionSchema } from '@/lib/validation/integration';

// The household's OurHomeInbox bill import: status (Settings card) and its
// connection. Seeing it needs settings:manage; changing the connection (a
// stored credential) is the Head of House's alone.
export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  return ok(await getInboxStatus(ctx.user.householdId!, can(ctx.user.role, 'household:manage')));
});

export const PUT = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const input = await parseBody(ctx.req, inboxConnectionSchema);
  return ok(await saveInboxConnection(ctx.user.householdId!, input));
});
