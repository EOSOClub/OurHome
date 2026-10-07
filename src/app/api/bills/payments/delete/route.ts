import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deletePayment } from '@/server/services/billService';
import { recordOwner } from '@/server/services/permissionService';
import { deletePaymentSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const { id } = await parseBody(ctx.req, deletePaymentSchema);
  await requireModify(ctx, 'bills', 'delete', await recordOwner.billPayment(householdId, id));
  await deletePayment(householdId, ctx.user.id, id);
  return ok({ id });
});
