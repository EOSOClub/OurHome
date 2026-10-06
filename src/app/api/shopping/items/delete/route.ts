import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { deleteShoppingItem } from '@/server/services/shoppingService';
import { itemIdSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'shopping:write');
  const { itemId } = await parseBody(ctx.req, itemIdSchema);
  await deleteShoppingItem(ctx.user.householdId!, ctx.user.id, itemId);
  return ok({ id: itemId });
});
