import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deletePayment } from '@/server/services/billService';
import { deletePaymentSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'bills:write');
  const { id } = await parseBody(ctx.req, deletePaymentSchema);
  await deletePayment(ctx.user.householdId!, ctx.user.id, id);
  return ok({ id });
});
