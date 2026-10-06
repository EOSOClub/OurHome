import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteBill } from '@/server/services/billService';
import { billIdSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'bills:write');
  const { id } = await parseBody(ctx.req, billIdSchema);
  await deleteBill(ctx.user.householdId!, ctx.user.id, id);
  return ok({ id });
});
