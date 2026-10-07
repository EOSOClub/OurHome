import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { updatePayment } from '@/server/services/billService';
import { recordOwner } from '@/server/services/permissionService';
import { updatePaymentSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, updatePaymentSchema);
  await requireModify(ctx, 'bills', 'edit', await recordOwner.billPayment(householdId, input.id));
  const payment = await updatePayment(householdId, ctx.user.id, input);
  return ok(payment);
});
