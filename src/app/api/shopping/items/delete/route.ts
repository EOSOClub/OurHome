import { ok, parseBody, requireModify, withAuth } from '@/server/api/http';
import { deleteShoppingItem } from '@/server/services/shoppingService';
import { recordOwner } from '@/server/services/permissionService';
import { itemIdSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  const householdId = ctx.user.householdId!;
  const { itemId } = await parseBody(ctx.req, itemIdSchema);
  await requireModify(
    ctx,
    'shopping',
    'delete',
    await recordOwner.shoppingItem(householdId, itemId),
  );
  await deleteShoppingItem(householdId, ctx.user.id, itemId);
  return ok({ id: itemId });
});
