import { ok, parseBody, withAuth } from '@/server/api/http';
import { setPaperlessPrivateNetwork } from '@/server/services/serverAdminService';
import { setPaperlessNetworkSchema } from '@/lib/validation/server';

// Allow a household's Paperless on the server's private network (or not). Server admin only.
export const POST = withAuth(async (ctx) => {
  const { id, allowed } = await parseBody(ctx.req, setPaperlessNetworkSchema);
  await setPaperlessPrivateNetwork(ctx.user.id, id, allowed);
  return ok({ id, allowed });
});
