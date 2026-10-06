import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { updatePayment } from '@/server/services/billService';
import { updatePaymentSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'bills:write');
  const input = await parseBody(ctx.req, updatePaymentSchema);
  const payment = await updatePayment(ctx.user.householdId!, ctx.user.id, input);
  return ok(payment);
});
