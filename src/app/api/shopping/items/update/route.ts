import { ok, parseBody, requirePermission, withAuth } from '@/server/api/http';
import { updateShoppingItem, itemToDTO } from '@/server/services/shoppingService';
import { updateShoppingItemSchema } from '@/lib/validation/shopping';

export const POST = withAuth(async (ctx) => {
  requirePermission(ctx, 'shopping:write');
  const input = await parseBody(ctx.req, updateShoppingItemSchema);
  const item = await updateShoppingItem(ctx.user.householdId!, ctx.user.id, input);
  return ok(itemToDTO(item));
});
