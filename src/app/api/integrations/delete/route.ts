import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteIntegration } from '@/server/services/integrationService';
import { integrationIdSchema } from '@/lib/validation/integration';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'settings:manage');
  const { id } = await parseBody(ctx.req, integrationIdSchema);
  await deleteIntegration(ctx.user.householdId!, ctx.user.id, id);
  return ok({ id });
});
