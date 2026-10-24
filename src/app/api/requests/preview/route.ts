import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { fetchLinkPreview } from '@/server/services/linkPreview';
import { getUserAccess } from '@/server/services/permissionService';
import { getRequestModules } from '@/server/services/requestModuleService';
import { ForbiddenError } from '@/server/services/errors';
import { roleMayAsk } from '@/lib/requestModules';
import { linkPreviewSchema } from '@/lib/validation/shopping';

// Fetch details for a purchase request's link: the same reader as Shopping's
// (which refuses private and local addresses on every hop), under
// /api/requests so it works where the Shopping feature is off. Only for
// someone who may ask for a purchase.
export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'requests:write');
  const [modules, access] = await Promise.all([getRequestModules(ctx.user.householdId!), getUserAccess(ctx.user)]);
  if (!modules.purchase.enabled || !access.requests.create || !roleMayAsk(modules.purchase, ctx.user.role)) {
    throw new ForbiddenError('You can’t make purchase requests.');
  }
  const { url } = await parseBody(ctx.req, linkPreviewSchema);
  const preview = await fetchLinkPreview(url);
  return ok(preview);
});
