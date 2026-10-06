import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { markBillPaid } from '@/server/services/billService';
import { markBillPaidSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'bills:write');
  const input = await parseBody(ctx.req, markBillPaidSchema);
  const bill = await markBillPaid(ctx.user.householdId!, ctx.user.id, input);
  return ok(bill);
});
