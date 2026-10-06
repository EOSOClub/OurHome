import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { updateBill } from '@/server/services/billService';
import { updateBillSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'bills:write');
  const input = await parseBody(ctx.req, updateBillSchema);
  const bill = await updateBill(ctx.user.householdId!, ctx.user.id, input);
  return ok(bill);
});
