import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { updateBill } from '@/server/services/billService';
import { recordOwner } from '@/server/services/permissionService';
import { updateBillSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const input = await parseBody(ctx.req, updateBillSchema);
  await requireModify(ctx, 'bills', 'edit', await recordOwner.bill(householdId, input.id));
  const bill = await updateBill(householdId, ctx.user.id, input);
  return ok(bill);
});
