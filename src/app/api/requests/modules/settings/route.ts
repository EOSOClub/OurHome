import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { getRequestModules, saveRequestModules } from '@/server/services/requestModuleService';
import { requestModulesSchema } from '@/lib/requestModules';

// Settings → Request types: which kinds of request are on and how each works.
// Head of House only.
export const GET = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  return ok(await getRequestModules(ctx.user.householdId!));
});

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'household:manage');
  const input = await parseBody(ctx.req, requestModulesSchema);
  return ok(await saveRequestModules(ctx.user.householdId!, input));
});
