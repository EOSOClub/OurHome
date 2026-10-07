import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteBill } from '@/server/services/billService';
import { recordOwner } from '@/server/services/permissionService';
import { billIdSchema } from '@/lib/validation/bills';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const { id } = await parseBody(ctx.req, billIdSchema);
  await requireModify(ctx, 'bills', 'delete', await recordOwner.bill(householdId, id));
  await deleteBill(householdId, ctx.user.id, id);
  return ok({ id });
});
